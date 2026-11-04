// Which receiver adapters a Send, Request Reply or Content Enricher step accepts. Measured with SAP's model check on a
// tenant (2026-11-04): one iFlow with each step kind joined to every receiver adapter of the bundled catalog. The
// tenant answers "<step> is not supported for the adapter" for the refused pairs; Content Enricher names its own list.
// Adapters not measured (not in the catalog) are not judged.

/** cname, or cname/message protocol where the protocol decides */
type AdapterId = string;

const ONE_WAY = ['AS2', 'sap:AMQP', 'sap:FTP', 'sap:JMS', 'sap:Mail', 'sap:SFTP'];
const REQUEST_REPLY_ONLY = [
  'AdobeSign', 'AdvancedEventMesh', 'AI', 'AmazonDynamoDB', 'AmazonEventBridge', 'AmazonKinesis', 'Anaplan', 'JDBC',
  'sap:HCIOData', 'sap:HTTP', 'sap:IDOC', 'sap:RFC', 'sap:SOAP/SOAP 1.x',
];

const matches = (list: AdapterId[], cname: string, mp: string) => list.some((a) => a === cname || a === `${cname}/${mp}`);
const label = (cname: string, mp: string) => `${cname.replace(/^sap:/, '')}${mp && mp !== 'None' && mp !== 'Not Applicable' ? ` (${mp})` : ''}`;

/**
 * Why the step (by its component name) cannot use this receiver adapter, or undefined when it can or was not measured.
 * adapterUri: the adapter's cmdVariantUri.
 */
export function adapterMisfit(stepCname: string, adapterUri: string): string | undefined {
  const cname = adapterUri.match(/cname::([^/]+)/)?.[1] ?? '';
  const mp = adapterUri.match(/mp::([^/]+)/)?.[1] ?? '';
  const name = label(cname, mp);
  if (stepCname === 'Send' && matches(REQUEST_REPLY_ONLY, cname, mp)) {
    return `Send does not support the ${name} adapter (SAP: "not supported for the adapter"); use Request Reply (ExternalCall) for it. ` +
      `Send takes: ${ONE_WAY.map((a) => label(a, '')).join(', ')}`;
  }
  if (stepCname === 'ExternalCall' && matches(ONE_WAY, cname, mp)) {
    return `Request Reply does not support the ${name} adapter (SAP: "not supported for the adapter"); use Send for it`;
  }
  if (stepCname === 'contentEnricherWithLookup' && cname && !(cname === 'sap:HCIOData' || `${cname}/${mp}` === 'sap:SOAP/SOAP 1.x' || /SuccessFactors/i.test(cname))) {
    return `Content Enricher does not support the ${name} adapter (SAP: "Content Enricher supports SuccessFactors, Soap1.x, and OData adapter types"); ` +
      'use Request Reply to call it and combine the messages in a later step';
  }
  return undefined;
}

/** Steps whose adapter connects from the external system to the step (the designer's arrow points at the step) */
export const ADAPTER_INTO_STEP = new Set(['contentEnricherWithLookup']);
