import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleDirectories = [
  join(projectRoot, 'src-tauri', 'target', 'release', 'bundle', 'msi'),
  join(projectRoot, 'src-tauri', 'target', 'release', 'bundle', 'nsis'),
];

let renamedCount = 0;

for (const directory of bundleDirectories) {
  if (!existsSync(directory)) {
    continue;
  }

  for (const fileName of readdirSync(directory)) {
    if (!fileName.startsWith('VoxNote_')) {
      continue;
    }

    const source = join(directory, fileName);
    const target = join(directory, fileName.replace(/^VoxNote_/, 'VoxNote-CUDA_'));
    if (existsSync(target)) {
      rmSync(target);
      console.log(`Replaced ${fileName.replace(/^VoxNote_/, 'VoxNote-CUDA_')}.`);
    }

    renameSync(source, target);
    console.log(`Renamed ${fileName} -> ${fileName.replace(/^VoxNote_/, 'VoxNote-CUDA_')}.`);
    renamedCount += 1;
  }
}

if (renamedCount === 0) {
  console.log('No unrenamed CUDA bundles found.');
}
