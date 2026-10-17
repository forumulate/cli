import type { GroupDef } from './resource';

/**
 * Spaces and what wraps them: the space itself (slugs, moves, duplicates,
 * the trash), its snapshots, its shape, its domains, its theme and assets,
 * the sites that join spaces together, and the space-type reference.
 */
const byHostname = { listOp: 'Domain_list', match: ['hostname'] };

export const SPACE_GROUPS: GroupDef[] = [
  {
    name: 'spaces',
    noun: 'space',
    about: 'spaces in an organization (docs, forum, blog, changelog, status, …)',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Space_list',
        about: 'List spaces (--deleted true for the trash)',
        columns: ['id', 'slug', 'type', 'name', 'visibility'],
      },
      overview: {
        op: 'Space_overview',
        about: 'Every space with its counts and last activity',
        columns: ['id', 'slug', 'type', 'name', 'updatedAt'],
      },
      get: { op: 'Space_get', about: 'Get one space (id or slug)', args: ['spaceId'] },
      create: {
        op: 'Space_create',
        about: 'Create a space (--slug, --type DOCS|FORUM|BLOG|…)',
        args: ['name'],
      },
      update: {
        op: 'Space_update',
        about: 'Update a space (--name, --visibility, --field settings.x=…)',
        args: ['spaceId'],
      },
      delete: {
        op: 'Space_remove',
        about: 'Delete a space (to the trash)',
        args: ['spaceId'],
        destructive: true,
      },
      restore: {
        op: 'Space_restore',
        about: 'Bring a space back from the trash',
        args: ['spaceId'],
      },
      purge: {
        op: 'Space_purge',
        about: 'Delete a trashed space for good',
        args: ['spaceId'],
        destructive: true,
      },
      duplicate: {
        op: 'Space_duplicate',
        about: 'Copy a space (--slug; --publish)',
        args: ['spaceId', 'name'],
      },
      move: {
        op: 'Space_move',
        about: 'Move a space to another organization you administer',
        args: ['spaceId', 'targetOrgId'],
        destructive: true,
      },
      rename: {
        op: 'Space_rename',
        about: 'Change the slug (the old one keeps redirecting)',
        args: ['spaceId', 'slug'],
      },
      'slugs list': {
        op: 'Space_slugHistory',
        about: 'Old slugs that still redirect here',
        args: ['spaceId'],
        columns: ['slug', 'createdAt'],
      },
      'slugs forget': {
        op: 'Space_forgetSlug',
        about: 'Stop an old slug redirecting (frees it)',
        args: ['spaceId', 'slug'],
        destructive: true,
      },
      access: {
        op: 'Space_myAccess',
        about: 'What you may do in a space, and why',
        args: ['spaceId'],
      },
      preview: {
        op: 'Space_preview',
        about: 'The space’s preview card (SVG)',
        args: ['spaceId'],
        download: 'preview.svg',
      },
    },
  },
  {
    name: 'snapshots',
    noun: 'snapshot',
    about: 'point-in-time copies of a space, and restoring from one',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'SpaceSnapshot_list',
        about: 'List snapshots',
        columns: ['id', 'label', 'pageCount', 'createdAt'],
      },
      create: { op: 'SpaceSnapshot_create', about: 'Take a snapshot', args: ['label'] },
      restore: {
        op: 'SpaceSnapshot_restore',
        about: 'Restore a snapshot (--newPages keep|remove)',
        args: ['id'],
        destructive: true,
      },
      delete: {
        op: 'SpaceSnapshot_remove',
        about: 'Delete a snapshot',
        args: ['id'],
        destructive: true,
      },
    },
  },
  {
    name: 'shape',
    noun: 'shape',
    about: 'a space’s shape override: sections, params, block types and kinds',
    defaultVerb: 'get',
    verbs: {
      get: { op: 'Shape_get', about: 'The effective shape (--preset to preview one)' },
      set: { op: 'Shape_put', about: 'Replace the override (--data @shape.json)' },
      patch: { op: 'Shape_patch', about: 'Merge a patch into the override (--data @patch.json)' },
      preset: { op: 'Shape_applyPreset', about: 'Apply a layout preset', args: ['name'] },
      'kinds default': {
        op: 'Shape_setDefaultKind',
        about: 'The kind a new piece gets',
        args: ['kind'],
      },
      'kinds set': {
        op: 'Shape_setKind',
        about: 'Add or replace a kind (--label, --data @kind.json for its patch)',
        args: ['name'],
      },
      'kinds remove': {
        op: 'Shape_removeKind',
        about: 'Remove a kind',
        args: ['name'],
        destructive: true,
      },
    },
  },
  {
    name: 'domains',
    noun: 'domain',
    about: 'custom domains on a space',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Domain_list',
        about: 'List domains',
        columns: ['id', 'hostname', 'basePath', 'verified', 'active'],
      },
      add: { op: 'Domain_add', about: 'Add a domain (--basePath /docs)', args: ['hostname'] },
      preview: {
        op: 'Domain_preview',
        about: 'What adding a domain would need, before adding it',
        args: ['hostname'],
      },
      subdomain: {
        op: 'Domain_allocateSubdomain',
        about: 'Take a free <name>.forumulate subdomain',
        args: ['subdomain'],
      },
      setup: {
        op: 'Domain_setup',
        about: 'What a domain is still waiting for',
        args: ['domainId'],
        lookup: { domainId: byHostname },
      },
      verify: {
        op: 'Domain_verify',
        about: 'Re-run verification (--activate true)',
        args: ['domainId'],
        lookup: { domainId: byHostname },
      },
      activate: {
        op: 'Domain_activate',
        about: 'Start serving a verified domain',
        args: ['domainId'],
        lookup: { domainId: byHostname },
      },
      www: {
        op: 'Domain_setWww',
        about: 'Also redirect www. (true|false)',
        args: ['domainId', 'alsoRedirectWww'],
        lookup: { domainId: byHostname },
      },
      'allow-ips': {
        op: 'Domain_setIpAllowList',
        about: 'Serve only to these IPs/CIDRs (a,b; empty for everyone)',
        args: ['domainId', 'ipAllowList'],
        lookup: { domainId: byHostname },
      },
      redirect: {
        op: 'Domain_setRedirect',
        about: 'Redirect the whole domain elsewhere (null to stop)',
        args: ['domainId', 'redirectTo'],
        lookup: { domainId: byHostname },
      },
      'acme-challenge': {
        op: 'Domain_setAcmeChallenge',
        about: 'Publish an ACME HTTP-01 answer (--token, --keyAuthorization)',
        args: ['hostname'],
      },
      remove: {
        op: 'Domain_remove',
        about: 'Remove a domain',
        args: ['domainId'],
        destructive: true,
        lookup: { domainId: byHostname },
      },
    },
  },
  {
    name: 'assets',
    noun: 'asset',
    about: 'files uploaded to a space (images, downloads)',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Asset_list',
        about: 'A space’s assets',
        columns: ['id', 'filename', 'contentType', 'size', 'url'],
      },
      all: {
        op: 'Asset_catalog',
        about: 'Every asset in the organization (--type, --search, --tag)',
        columns: ['id', 'filename', 'contentType', 'spaceId', 'url'],
      },
      upload: { op: 'Asset_upload', about: 'Upload a file', args: ['file'], upload: 'file' },
      download: {
        op: 'Asset_serve',
        about: 'Fetch an asset’s bytes (--w for a resized image)',
        args: ['id'],
        download: 'asset',
      },
      delete: {
        op: 'Asset_remove',
        about: 'Delete an asset',
        args: ['assetId'],
        destructive: true,
      },
    },
  },
  {
    name: 'space-types',
    aliases: ['types'],
    noun: 'space type',
    about: 'what each kind of space is: tabs, pieces, fields, layout presets, slots',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'SpaceTypes_list',
        about: 'Every space type',
        columns: ['type', 'label', 'piece'],
      },
      get: { op: 'SpaceTypes_one', about: 'One type in full', args: ['type'] },
      presets: { op: 'SpaceTypes_allPresets', about: 'Every layout preset, by type' },
      slots: { op: 'SpaceTypes_allSlots', about: 'Every layout slot, by type' },
      'type-presets': { op: 'SpaceTypes_presets', about: 'One type’s presets', args: ['type'] },
      'type-slots': { op: 'SpaceTypes_slots', about: 'One type’s slots', args: ['type'] },
    },
  },
];
