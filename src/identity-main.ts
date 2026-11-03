// Separate administrative entry point: no HTTP client, Admin, scheduler or general delivery.
import { config } from './config.js';
import { errorCode, log } from './errors.js';
import { parseRequest } from './identity/request.js';
import { identityCommand } from './identity/migrate.js';
async function main(){
 const request=parseRequest(process.argv.slice(2));
 const result=await identityCommand(config(),request);
 log('corporate_identity_result',result);
}
main().catch(error=>{log('corporate_identity_stopped',{error:errorCode(error)});process.exitCode=1;});
