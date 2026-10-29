// Non-consuming HTTP homologation. No database writes and no transactional endpoints.
// Build first; run with node --env-file=/private/config.env scripts/homologate-http.mjs.
import { OlosAuthManager } from '../dist/auth.js';
import { OlosApi, rows } from '../dist/api.js';
import { HttpTransport } from '../dist/http.js';
import { WorkerError, errorCode } from '../dist/errors.js';
import { olosTlsVerify } from '../dist/config.js';

const emit = (event, fields={}) => process.stdout.write(JSON.stringify({event,...fields})+'\n');
const required = name => {
  if(!process.env[name]) throw new WorkerError(`CONFIG_REQUIRED_${name}`);
  return process.env[name];
};
const positive = (name,fallback,max) => {
  const value=Number(process.env[name]??fallback);
  if(!Number.isSafeInteger(value)||value<1||value>max)throw new WorkerError(`CONFIG_INVALID_${name}`);
  return value;
};
async function main() {
  const credentials={username:required('OLOS_USERNAME'),password:required('OLOS_PASSWORD'),clientId:required('OLOS_CLIENT_ID'),clientSecret:required('OLOS_CLIENT_SECRET')};
  const abort=new AbortController();
  const stop=()=>abort.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const verify=olosTlsVerify();
  emit('tls_configuration',{verify,scope:'OLOS_HTTP_ONLY'});
  const http=new HttpTransport(required('OLOS_BASE_URL'),positive('HTTP_TIMEOUT_MS',10000,300000),positive('MAX_RESPONSE_BYTES',33554432,268435456),abort.signal,verify);
  let passwordGrants=0,refreshGrants=0;
  const staticFields={Disposition:['DispositionId','Description'],Campaign:['CampaignId','Description','CampaignCode'],Users:['UserId','AgentId','UserName']};
  const request=async(path,fields,token)=>{
    if(path==='/api/auth' && ['password','refresh_token'].includes(fields?.grant_type)) {
      if(fields.grant_type==='password')passwordGrants++;else refreshGrants++;
    } else if(path==='/api/export-data/available-tables' && fields===undefined) {
      // GET only.
    } else if(path==='/api/export-data/read-data' && Object.hasOwn(staticFields,fields?.TableName??'') && Object.keys(fields).length===1) {
      // Only these three static tables; never log or save response bodies.
    } else throw new WorkerError('HOMOLOGATION_ENDPOINT_FORBIDDEN');
    const started=performance.now();
    const operation=path==='/api/auth'?`auth_${fields.grant_type}`:path.endsWith('available-tables')?'available_tables':fields.TableName;
    try {
      const body=await http.request(path,fields,token);
      emit('http_result',{operation,status:200,duration_ms:Math.round(performance.now()-started)});
      if(path==='/api/auth') {
        let value;try{value=JSON.parse(body);}catch{}
        emit('auth_response_shape',{json_object:Boolean(value&&typeof value==='object'&&!Array.isArray(value)),access_token_present:typeof value?.access_token==='string'&&value.access_token.length>0,refresh_token_present:typeof value?.refresh_token==='string'&&value.refresh_token.length>0,expires_in:Number.isFinite(Number(value?.expires_in))?Number(value.expires_in):null});
      }
      return body;
    } catch(error) {
      emit('http_result',{operation,status:Number.isInteger(error.status)?error.status:null,duration_ms:Math.round(performance.now()-started),error:errorCode(error)});
      throw error;
    }
  };
  const auth=new OlosAuthManager(request,credentials);
  const api=new OlosApi(request,auth);
  let failed=false;
  try {
    const first=await auth.getToken();emit('auth_password_passed');
    auth.invalidate(first);await auth.getToken();
    emit('auth_renewal_result',{password_grants:passwordGrants,refresh_grants:refreshGrants});
    if(refreshGrants!==1 || passwordGrants!==1) {failed=true;emit('auth_refresh_not_confirmed');}
    try {await api.available();emit('available_tables_passed');}
    catch(error) {failed=true;emit('available_tables_failed',{error:errorCode(error)});}
    for(const [table,expected] of Object.entries(staticFields)) {
      try {
        const data=rows(await api.call('/api/export-data/read-data',{TableName:table})).map(row=>
          Object.fromEntries(expected.filter(field=>Object.hasOwn(row,field)).map(field=>[field,row[field]])));
        const idField=table==='Users'?'AgentId':expected[0];
        const nameField=table==='Users'?'UserName':'Description';
        const names=new Map();let incomplete=0,ambiguous=0;
        for(const row of data) {
          // Only inspect the allowlisted fields. No Users.Password value or name is emitted.
          if(expected.some(field=>!Object.hasOwn(row,field)))incomplete++;
          const id=row[idField],name=row[nameField];
          if(id!=null && name!=null) {
            if(names.has(id) && names.get(id)!==name)ambiguous++;
            names.set(id,name);
          }
        }
        const passed=incomplete===0 && ambiguous===0;
        if(!passed)failed=true;
        emit('static_table_result',{table,passed,rows:data.length,incomplete_rows:incomplete,ambiguous_reference_ids:ambiguous,layout_observed:data.length>0});
      } catch(error) {failed=true;emit('static_table_failed',{table,error:errorCode(error)});}
    }
    if(failed)process.exitCode=1;
  } finally {
    abort.abort();await http.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
}
main().catch(error=>{emit('homologation_failed',{error:errorCode(error)});process.exitCode=1;});
