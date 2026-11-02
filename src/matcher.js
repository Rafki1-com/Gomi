'use strict';

function isCompatible(a, b) {
  const aWantsB = !a.desiredCountry || a.desiredCountry === 'ANY' || a.desiredCountry === b.country;
  const bWantsA = !b.desiredCountry || b.desiredCountry === 'ANY' || b.desiredCountry === a.country;
  return aWantsB && bWantsA;
}

function findCompatible(waitingEntries, current, isBlocked = () => false) {
  for (const entry of waitingEntries) {
    if (entry.socketId === current.socketId) continue;
    if (!isCompatible(current, entry)) continue;
    if (isBlocked(current.userId, entry.userId) || isBlocked(entry.userId, current.userId)) continue;
    return entry;
  }
  return null;
}

module.exports = { isCompatible, findCompatible };
