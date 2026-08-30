#!/usr/bin/env node
import {
  listSupportedNodeVersions,
  nodeVersionAliases,
} from '../src/versions/index.js';

const matrix = {
  aliases: nodeVersionAliases(),
  versions: listSupportedNodeVersions(),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(matrix, null, 2));
} else {
  console.log('ALIAS      TARGET');
  for (const [alias, target] of Object.entries(matrix.aliases)) {
    console.log(`${alias.padEnd(10)} ${target}`);
  }
  console.log('\nVERSION  MATURITY  STATUS            REFERENCE  EOL');
  for (const record of matrix.versions) {
    console.log(`${record.id.padEnd(8)} ${record.maturity.padEnd(9)} ${record.status.padEnd(17)} ${record.referenceVersion.padEnd(10)} ${record.endOfLife}`);
  }
}
