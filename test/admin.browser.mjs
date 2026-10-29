// Full browser homologation against the dedicated local simulator profile ONLY.
// Start with: node scripts/admin-homolog.mjs setup && node scripts/admin-homolog.mjs start
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.ADMIN_PLAYWRIGHT_PATH||'playwright');
const execute=promisify(execFile),origin='http://localhost:8081';
const stats=await fetch('http://127.0.0.1:18081/mock-stats').then(r=>r.json());assert.equal(stats.non_auth_requests,0);
const browser=await chromium.launch({headless:true,...(process.env.ADMIN_CHROMIUM_PATH?{executablePath:process.env.ADMIN_CHROMIUM_PATH}:{})});
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[],requests=[],responses=[];
page.on('pageerror',error=>errors.push(error.message));page.on('request',r=>requests.push(r.url()));page.on('response',r=>{if(r.url().includes('/api/'))responses.push(r.text().catch(()=>''));});
const login=async(username,password)=>{const f=page.locator('#login-form');await f.getByLabel('Usuário OLOS',{exact:true}).fill(username);await f.getByLabel('Senha OLOS',{exact:true}).fill(password);await f.getByRole('button',{name:'Entrar',exact:true}).click();};
try {
  await page.goto(origin);
  await login('homolog-admin','wrong');await page.waitForFunction(()=>document.querySelector('#login-error').textContent.includes('autenticar'));
  await login('homolog-visitor','homolog-password');await page.waitForFunction(()=>document.querySelector('#login-error').textContent.includes('sem autorização'));
  await login('homolog-admin','homolog-password');await page.locator('#app').waitFor({state:'visible'});
  assert.equal(await page.locator('#login-form input[type=password]').inputValue(),'');
  await page.waitForFunction(()=>document.querySelector('#auth-health').textContent==='Aceita nesta sessão');
  assert.match(await page.locator('#db-health').textContent(),/estrutura inválida/);assert.match(await page.locator('#ingestion-health').textContent(),/Sem ciclo confirmado/);
  await page.getByRole('button',{name:'Agendamento',exact:true}).click();await page.getByLabel('Intervalo em minutos').fill('3');await page.getByRole('button',{name:'Salvar intervalo'}).click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Intervalo salvo'));
  await page.getByRole('button',{name:'Credenciais OLOS',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#credentials-complete').textContent.includes('completa'));
  assert.equal(await page.locator('#credentials-form input[name=password]').inputValue(),'');assert.equal(await page.locator('input[name=clientId],input[name=clientSecret]').count(),0);
  await page.getByRole('button',{name:'Salvar credenciais'}).click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Credenciais salvas'));
  await page.getByRole('button',{name:'Testar conexão salva'}).click();await page.waitForFunction(()=>document.querySelector('#test-result').textContent.includes('Autenticação validada'));
  await page.getByRole('button',{name:'Iniciar Worker',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#state').textContent==='ERROR');
  await page.getByRole('button',{name:'Dashboard',exact:true}).click();assert.match(await page.locator('#worker-error').textContent(),/unicidade/);
  await page.getByRole('button',{name:'Sair',exact:true}).click();await page.locator('#login').waitFor({state:'visible'});
  await login('homolog-admin','homolog-password');await page.locator('#app').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#state').textContent==='ERROR');
  await page.getByRole('button',{name:'Parar Worker',exact:true}).click();await page.getByRole('dialog').waitFor({state:'visible'});
  await page.getByRole('button',{name:'Confirmar parada'}).click();await page.waitForFunction(()=>document.querySelector('#state').textContent==='STOPPED');
  await page.getByRole('button',{name:'Terminal / Logs',exact:true}).click();await page.getByRole('button',{name:'Dashboard',exact:true}).click();
  if(process.env.ADMIN_SCREENSHOT)await page.screenshot({path:process.env.ADMIN_SCREENSHOT,fullPage:true});
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.deepEqual(errors,[]);assert(requests.every(url=>url.startsWith(origin+'/')));assert.doesNotMatch((await Promise.all(responses)).join(''),/homolog-password|homolog-client|PRIVATE_MOCK|access_token|refresh_token/);
  await execute(process.execPath,['scripts/admin-homolog.mjs','restart']);
  await page.goto(origin);await page.locator('#login').waitFor({state:'visible'});await login('homolog-admin','homolog-password');await page.locator('#app').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#state').textContent==='STOPPED');
  await page.getByRole('button',{name:'Sair',exact:true}).click();await page.locator('#login').waitFor({state:'visible'});
  const finalStats=await fetch('http://127.0.0.1:18081/mock-stats').then(r=>r.json());assert.equal(finalStats.non_auth_requests,0);
  console.log('Browser homologation passed on localhost:8081: OLOS login/denial, CSRF session, schedule, hidden technical secrets, auth-only test, ERROR navigation, no ingestion, stop, restart, logout.');
} finally {await browser.close();}
