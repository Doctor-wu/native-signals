export interface IEffect {
	queuedNext: IEffect | undefined;
	queue(): void;
}

export interface Dependency {
	subs: Link | undefined;
	subsTail: Link | undefined;
	subVersion: number;
	update?(): void;
}

export interface Subscriber {
	/**
	 * When tracking, this is version.
	 * When not tracking, this is dirty level.
	 */
	versionOrDirtyLevel: number | DirtyLevels;
	deps: Link | undefined;
	depsTail: Link | undefined;
}

export const enum DirtyLevels {
	NotDirty,
	QueryingDirty,
	MaybeDirty,
	Dirty,
}

export class Link {
	static pool: Link[] = [];

	prevSub: Link | undefined = undefined;
	nextSub: Link | undefined = undefined;
	nextDep: Link | undefined = undefined;
	broadcastNext: Link | undefined = undefined;

	constructor(
		public dep: Dependency,
		public sub: Subscriber & ({} | IEffect | Dependency)
	) { }

	static get(dep: Dependency, sub: Subscriber): Link {
		if (Link.pool.length > 0) {
			const link = Link.pool.pop()!;
			link.dep = dep;
			link.sub = sub;
			return link;
		} else {
			return new Link(dep, sub);
		}
	}

	static releaseDeps(toBreak: Link) {
		let nextDep = toBreak.nextDep;
		while (nextDep !== undefined) {
			toBreak.nextDep = undefined;
			const nextNext = nextDep.nextDep;
			Link.release(nextDep);
			toBreak = nextDep;
			nextDep = nextNext;
		}
	}

	static release(link: Link) {
		const nextSub = link.nextSub;
		const prevSub = link.prevSub;

		if (nextSub !== undefined) {
			nextSub.prevSub = prevSub;
		}
		if (prevSub !== undefined) {
			prevSub.nextSub = nextSub;
		}

		if (nextSub === undefined) {
			link.dep.subsTail = prevSub;
		}
		if (prevSub === undefined) {
			link.dep.subs = nextSub;
		}

		// @ts-ignore
		link.dep = undefined;
		// @ts-ignore
		link.sub = undefined;
		link.prevSub = undefined;
		link.nextSub = undefined;
		link.nextDep = undefined;

		Link.pool.push(link);
	}
}

export namespace Dependency {

	export function link(dep: Dependency) {
		if (pausedSubs) {
			return;
		}
		if (dep.subVersion === activeSub!.versionOrDirtyLevel) {
			return;
		}
		const sub = activeSub!;
		dep.subVersion = sub.versionOrDirtyLevel;

		const old = sub.depsTail !== undefined
			? sub.depsTail.nextDep
			: sub.deps;

		if (old === undefined || old.dep !== dep) {
			const newLink = Link.get(dep, sub);
			if (old !== undefined) {
				const nextDep = old.nextDep;
				Link.release(old);
				newLink.nextDep = nextDep;
			}
			if (sub.depsTail === undefined) {
				sub.depsTail = sub.deps = newLink;
			}
			else {
				sub.depsTail = sub.depsTail!.nextDep = newLink;
			}
			if (dep.subs === undefined) {
				dep.subsTail = dep.subs = newLink;
			}
			else {
				newLink.prevSub = dep.subsTail;
				dep.subsTail = dep.subsTail!.nextSub = newLink;
			}
		}
		else {
			sub.depsTail = old;
		}
	}

	export function broadcast(dep: Dependency) {
		let dirtyLevel = DirtyLevels.Dirty;
		let currentSubs = dep.subs;
		let lastSubs = currentSubs!;

		while (currentSubs !== undefined) {
			let subLink: Link | undefined = currentSubs;

			while (subLink !== undefined) {
				const sub = subLink.sub;
				const subDirtyLevel = sub.versionOrDirtyLevel;

				if (subDirtyLevel === DirtyLevels.NotDirty) {
					if ('subs' in sub && sub.subs !== undefined) {
						lastSubs = lastSubs.broadcastNext = sub.subs;
					}
					if ('queue' in sub) {
						if (queuedEffectsTail !== undefined) {
							queuedEffectsTail = queuedEffectsTail.queuedNext = sub;
						}
						else {
							queuedEffects = queuedEffectsTail = sub;
						}
					}
				}

				if (subDirtyLevel < dirtyLevel) {
					sub.versionOrDirtyLevel = dirtyLevel;
				}

				subLink = subLink.nextSub;
			}

			dirtyLevel = DirtyLevels.MaybeDirty;
			const broadcastNext = currentSubs.broadcastNext;
			currentSubs.broadcastNext = undefined;
			currentSubs = broadcastNext;
		}
	}
}

export namespace Subscriber {

	export function isDirty(sub: Subscriber) {
		while (sub.versionOrDirtyLevel === DirtyLevels.MaybeDirty) {
			sub.versionOrDirtyLevel = DirtyLevels.QueryingDirty;
			const resumeIndex = pauseTracking();
			let link = sub.deps;
			while (link !== undefined) {
				if (link.dep.update !== undefined) {
					link.dep.update();
					if (sub.versionOrDirtyLevel >= DirtyLevels.Dirty) {
						break;
					}
				}
				link = link.nextDep;
			}
			resetTracking(resumeIndex);
			if (sub.versionOrDirtyLevel === DirtyLevels.QueryingDirty) {
				sub.versionOrDirtyLevel = DirtyLevels.NotDirty;
			}
		}
		return sub.versionOrDirtyLevel === DirtyLevels.Dirty;
	}

	export function trackStart(sub: Subscriber) {
		const lastActiveSub = activeSub;
		activeSub = sub;
		activeSubsDepth++;
		pausedSubs = false;
		Subscriber.preTrack(sub);
		return lastActiveSub;
	}

	export function trackEnd(sub: Subscriber, lastActiveSub: Subscriber | undefined) {
		Subscriber.postTrack(sub);
		activeSubsDepth--;
		pausedSubs = activeSubsDepth - pausedSubsIndex <= 0;
		activeSub = lastActiveSub;
	}

	export function preTrack(sub: Subscriber) {
		sub.depsTail = undefined;
		sub.versionOrDirtyLevel = subVersion++;
	}

	export function postTrack(sub: Subscriber) {
		if (sub.depsTail !== undefined) {
			Link.releaseDeps(sub.depsTail);
		}
		else if (sub.deps !== undefined) {
			Link.releaseDeps(sub.deps);
			Link.release(sub.deps);
			sub.deps = undefined;
		}
		sub.versionOrDirtyLevel = DirtyLevels.NotDirty;
	}
}

let activeSub: Subscriber | undefined = undefined;
let activeSubsDepth = 0;
let pausedSubsIndex = 0;
let pausedSubs = true;
let batchDepth = 0;
let subVersion = 0;
let queuedEffects: IEffect | undefined = undefined;
let queuedEffectsTail: IEffect | undefined = undefined;

export function pauseTracking() {
	const lastPausedIndex = pausedSubsIndex;
	pausedSubsIndex = activeSubsDepth;
	pausedSubs = true;
	return lastPausedIndex;
}

export function resetTracking(lastPausedIndex: number) {
	pausedSubsIndex = lastPausedIndex;
	pausedSubs = activeSubsDepth - pausedSubsIndex <= 0;
}

export function batchStart() {
	batchDepth++;
}

export function batchEnd() {
	batchDepth--;
	while (batchDepth === 0 && queuedEffects !== undefined) {
		const effect = queuedEffects;
		const queuedNext = queuedEffects.queuedNext;
		if (queuedNext !== undefined) {
			queuedEffects.queuedNext = undefined;
			queuedEffects = queuedNext;
		}
		else {
			queuedEffects = undefined;
			queuedEffectsTail = undefined;
		}
		effect.queue();
	}
}
