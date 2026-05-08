import { LassoClient } from '../src/lasso/client.js';
import { getCreditsafeRating } from '../src/lasso/creditsafe.js';
import { getCvrEntity, searchCvr } from '../src/lasso/cvr.js';
import { getCvrReports, getFinancialAnalysis } from '../src/lasso/financials.js';
import { getOwnershipGraph } from '../src/lasso/network.js';
import { getCompanyPhoneNumbers } from '../src/lasso/teledata.js';

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

  const reports = await getCvrReports(client, {
    entityType: 'company',
    id: '34580820',
  });

  console.log(JSON.stringify({ reports }, null, 2));

  if (process.env.LASSO_FINANCIAL_ANALYSIS === '1') {
    const analysis = await getFinancialAnalysis(client, {
      entityType: 'company',
      id: '34580820',
    });

    console.log(JSON.stringify({ analysis }, null, 2));
  } else {
    console.log(
      'Skipping lassox_financial_analysis. Set LASSO_FINANCIAL_ANALYSIS=1 to call the Module API (may require subscription).',
    );
  }

  if (process.env.LASSO_CREDITSAFE === '1') {
    const credit = await getCreditsafeRating(client, { cvr: '34580820' });
    console.log(JSON.stringify({ credit }, null, 2));
  } else {
    console.log('Skipping creditsafe_get_rating. Set LASSO_CREDITSAFE=1 to call it.');
  }

  if (process.env.LASSO_TELEDATA === '1') {
    const phones = await getCompanyPhoneNumbers(client, {
      entityType: 'company',
      id: '34580820',
    });
    console.log(JSON.stringify({ phones }, null, 2));
  } else {
    console.log('Skipping teledata_get_company_phones. Set LASSO_TELEDATA=1 to call it.');
  }

  if (process.env.LASSO_OWNERSHIP === '1') {
    const graph = await getOwnershipGraph(client, {
      ids: ['CVR-1-34580820'],
      enrichments: ['companyinfo'],
      outgoingDepth: 1,
    });
    console.log(JSON.stringify({ graph }, null, 2));
  } else {
    console.log(
      'Skipping cvr_get_ownership_graph. Set LASSO_OWNERSHIP=1 to call the Module API (may require subscription).',
    );
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
