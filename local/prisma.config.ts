import { defineConfig } from 'prisma/config';
import { localDatabaseUrl } from './src/config.js';
export default defineConfig({
  schema:'prisma/schema.prisma',
  migrations:{path:'prisma/migrations'},
  datasource:{url:localDatabaseUrl(process.env.LOCAL_DATABASE_URL??'postgresql://olos_local@localhost:5432/olos_http_local')},
});
