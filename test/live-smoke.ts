import { LassoClient } from '../src/lasso/client.js';
import { getCvrEntity, searchCvr } from '../src/lasso/cvr.js';

async function main(): Promise<void> {
  if (!process.env.LASSO_API_KEY) {
    throw new Error('Set LASSO_API_KEY before running npm run smoke:live.');
  }

  const client = new LassoClient();
  const search = await searchCvr(client, {
    query: 'Lasso X',
    type: 'company',
    pageSize: 1,
  });

  console.log(JSON.stringify({ search }, null, 2));

  const entity = await getCvrEntity(client, {
    entityType: 'company',
    id: '34580820',
  });

  console.log(JSON.stringify({ entity }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
