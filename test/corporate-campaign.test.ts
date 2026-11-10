import {test} from 'node:test';
import assert from 'node:assert/strict';
import {campaignPolicyCode,assertCampaignAllowed,isCampaignPolicyError} from '../src/corporate-sync/campaign-policy.js';
import {retryable} from '../src/corporate-sync/errors.js';
import {mapRecord} from '../src/mapping.js';
test('manual campaigns match complete names with case/Unicode whitespace normalization only',()=>{
  for(const name of ['Ligacao Manual','Ligacao Manual GS',' LIGACAO   manual ','\tLigacao\u00a0Manual\u2003GS\ufeff']){
    assert.equal(campaignPolicyCode(name),'MANUAL_CAMPAIGN_EXCLUDED');
    assert.throws(()=>assertCampaignAllowed(name),error=>isCampaignPolicyError(error)&&!retryable(error));
  }
  for(const name of ['Campaign','Ligacao Manual Extra','Campanha Ligacao Manual','LigacaoManual','Manual'])assert.equal(campaignPolicyCode(name),null);
});
test('unknown campaign identity is held without an inferred ID, name or retryable error',()=>{
  for(const name of [null,undefined,'','\u00a0\t\ufeff',7,{}]){
    assert.equal(campaignPolicyCode(name),'CAMPAIGN_IDENTIFICATION_REQUIRED');
    assert.throws(()=>assertCampaignAllowed(name),/CAMPAIGN_IDENTIFICATION_REQUIRED/);
  }
});
test('ExportDataV3 CampaignId resolves through Campaign.Description; AgentStatus and Billing IDs are not the criterion',()=>{
  const cache={users:new Map([['7','Agent']]),campaigns:new Map([['811','Ligacao Manual'],['812','Campaign']]),dispositions:new Map<string,string>()};
  const raw={AttemptsRawDataID:'1',CallId:'synthetic',CampaignId:'811',AgentId:'7',AgentStatus:'1'};
  const manual=mapRecord(raw,cache);assert.equal(manual.id_campanha_olos,'811');assert.equal(manual.nome_campanha_olos,'Ligacao Manual');assert.equal(campaignPolicyCode(manual.nome_campanha_olos),'MANUAL_CAMPAIGN_EXCLUDED');
  const other=mapRecord({...raw,CampaignId:'812',AgentStatus:'9'},cache);assert.equal(campaignPolicyCode(other.nome_campanha_olos),null);
  const unknown=mapRecord({...raw,CampaignId:'999'},cache);assert.equal(unknown.id_campanha_olos,'999');assert.equal(unknown.nome_campanha_olos,null);
});
