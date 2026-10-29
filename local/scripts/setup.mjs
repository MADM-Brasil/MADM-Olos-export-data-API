import {randomBytes} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
const file=new URL('../.env',import.meta.url);
await writeFile(file,`LOCAL_ADMIN_PASSWORD=${randomBytes(24).toString('hex')}\nLOCAL_APP_PASSWORD=${randomBytes(24).toString('hex')}\nLOCAL_SOURCE_KEY=olos-local-fixture\nBATCH_SIZE=500\nSOURCE_TIME_ZONE=\nOLOS_TLS_VERIFY=true\n`,{mode:0o600,flag:'wx'});
await mkdir(new URL('../inputs/',import.meta.url),{recursive:true,mode:0o700});
console.log(JSON.stringify({event:'local_configuration_created',credentials_printed:false,existing_configuration_overwritten:false}));
