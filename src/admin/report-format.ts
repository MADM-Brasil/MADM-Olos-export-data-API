import { validateReportData, reportValidationMetadata, validReportMetadata, type ReportData } from './report-snapshot.js';
import type { PoolClient } from 'pg';
export interface ReportFormat {
  version:number;
  name:string;
  validate(input:unknown):ReportData;
  metadata(data:ReportData):unknown;
  validMetadata(input:unknown,data:ReportData):boolean;
  collect?(db:PoolClient,source:string,destination:{schema:string;table:string}):Promise<ReportData>;
}
// Kept as a separate, unchanged contract for existing generations and rollback.
export const legacyReportFormat:ReportFormat={version:1,name:'olos-admin-reports/v1',validate:validateReportData,
  metadata:reportValidationMetadata,validMetadata:validReportMetadata};
