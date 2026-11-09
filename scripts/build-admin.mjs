// The frontend is self-hosted static assets. Validate JavaScript before packaging;
// no dev server, deployment, scheduler or operational configuration is loaded.
import { execFileSync } from 'node:child_process';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','admin/tsconfig.json'],{cwd:root,stdio:'inherit'});
const destination=new URL('../dist/admin/public/',import.meta.url);
await mkdir(destination,{recursive:true});
for(const file of ['index.html','style.css','app.js','ui.js','dashboard.js'])await copyFile(new URL('../admin/public/'+file,import.meta.url),new URL(file,destination));
console.log('Admin static build: dist/admin/public (5 validated assets; no deployment).');
