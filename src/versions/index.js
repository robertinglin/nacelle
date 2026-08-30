import { node22Profile } from './v22/profile.js';
import {
  NODE_VERSION_ALIASES,
  NODE_VERSION_RECORDS,
  listSupportedNodeVersions,
  nodeVersionAliases,
  resolveNodeVersionRecord,
} from './support.js';

const profiles = new Map([
  [node22Profile.id, node22Profile],
]);

export function resolveNodeVersionProfile(value = 'lts') {
  const record = resolveNodeVersionRecord(value);
  return profiles.get(record.id);
}

export function listNodeVersionProfiles() {
  return NODE_VERSION_RECORDS.map((record) => profiles.get(record.id));
}

export {
  NODE_VERSION_ALIASES,
  NODE_VERSION_RECORDS,
  listSupportedNodeVersions,
  nodeVersionAliases,
  resolveNodeVersionRecord,
};
