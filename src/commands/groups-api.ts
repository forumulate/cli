import type { GroupDef } from './resource';

/**
 * API documentation automation: OpenAPI specs turned into reference pages
 * (register, re-sync, lint, generate) and the SDKs built from them,
 * published to package registries.
 *
 * The API-docs product had no API-docs automation from a terminal: a spec
 * changes in CI, and `openapi resync` is the step after it.
 */
export const API_GROUPS: GroupDef[] = [
  {
    name: 'openapi',
    noun: 'spec',
    about: 'OpenAPI specs behind a docs space’s reference pages',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'OpenApi_listSpecs',
        about: 'Registered specs',
        columns: ['id', 'name', 'sourceUrl', 'lastSyncedAt'],
      },
      register: {
        op: 'OpenApi_registerSpec',
        about: 'Register a spec URL and build its pages (--collectionId, --mode)',
        args: ['sourceUrl'],
      },
      resync: {
        op: 'OpenApi_resyncSpec',
        about: 'Re-read the spec and update its pages (--background true)',
        args: ['id'],
      },
      'resync status': {
        op: 'OpenApi_resyncStatus',
        about: 'How a background re-sync is going',
        args: ['id', 'jobId'],
      },
      reference: { op: 'OpenApi_specReference', about: 'The pages a spec built', args: ['id'] },
      lint: { op: 'OpenApi_specLint', about: 'Lint a registered spec', args: ['id'] },
      'lint url': { op: 'OpenApi_lintUrl', about: 'Lint any spec URL', args: ['sourceUrl'] },
      delete: {
        op: 'OpenApi_removeSpec',
        about: 'Unregister a spec',
        args: ['id'],
        destructive: true,
      },
      import: {
        op: 'OpenApi_import',
        about: 'Import a spec into a collection (--url, --collectionId, --dryRun)',
      },
      'import file': {
        op: 'OpenApi_importFile',
        about: 'Import a spec file (--form file=@openapi.yaml --form collectionId=…)',
      },
      operations: {
        op: 'OpenApi_operations',
        about: 'The operations a spec URL declares',
        args: ['url'],
      },
      resolve: {
        op: 'OpenApi_resolve',
        about: 'One operation of a spec URL, resolved',
        args: ['url', 'method', 'path'],
      },
      generate: {
        op: 'OpenApi_generate',
        about: 'Write guide pages from a spec (--url, --enhance; your AI provider)',
      },
      'generate status': {
        op: 'OpenApi_generateStatus',
        about: 'How a generate job is going',
        args: ['jobId'],
      },
      'sdk languages': { op: 'OpenApi_sdkLanguages', about: 'The SDK languages we generate' },
      'sdk get': {
        op: 'OpenApi_specSdk',
        about: 'One generated SDK’s files, as JSON',
        args: ['id', 'language'],
      },
      'sdk download': {
        op: 'OpenApi_specSdkPackage',
        about: 'One generated SDK as a package archive',
        args: ['id', 'language'],
        download: 'sdk.zip',
      },
    },
  },
  {
    name: 'sdks',
    noun: 'SDK package',
    about: 'generated SDK packages and the registries they publish to',
    defaultVerb: 'packages',
    verbs: {
      packages: {
        op: 'SdkPublishing_listPackages',
        about: 'A space’s SDK packages',
        columns: ['id', 'language', 'packageName', 'version'],
      },
      register: {
        op: 'SdkPublishing_registerPackage',
        about: 'Register a spec’s SDK as a package (--packageName)',
        args: ['specId', 'language'],
      },
      publish: {
        op: 'SdkPublishing_publish',
        about: 'Publish a package to a registry (npm, pypi, …)',
        args: ['packageId', 'target'],
      },
      publishes: {
        op: 'SdkPublishing_listPublishes',
        about: 'A package’s publish history',
        args: ['packageId'],
        columns: ['id', 'target', 'version', 'status', 'createdAt'],
      },
      'registries list': {
        op: 'SdkPublishing_listRegistries',
        about: 'Connected registries',
        columns: ['registry', 'configured', 'updatedAt'],
      },
      'registries set': {
        op: 'SdkPublishing_setRegistry',
        about: 'Connect a registry (--token; --settings)',
        args: ['registry'],
      },
      'registries test': {
        op: 'SdkPublishing_testRegistry',
        about: 'Check a registry’s credentials',
        args: ['registry'],
      },
      'registries remove': {
        op: 'SdkPublishing_deleteRegistry',
        about: 'Disconnect a registry',
        args: ['registry'],
        destructive: true,
      },
    },
  },
];
