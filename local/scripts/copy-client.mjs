import {cpSync} from 'node:fs';
cpSync(new URL('../generated/',import.meta.url),new URL('../dist/local/generated/',import.meta.url),{recursive:true});
