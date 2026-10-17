import type { GroupDef } from './resource';

/**
 * The organization's people and plumbing: orgs, members, invites, groups,
 * roles, service accounts, tokens, webhooks, extensions, audit.
 *
 * Onboarding 200 people is a script, not 200 clicks, and the token a CI job
 * runs on is rotated from a terminal — these are what an org admin scripts.
 */
export const ORG_GROUPS: GroupDef[] = [
  {
    name: 'orgs',
    noun: 'org',
    about: 'organizations you belong to, their DeepL key and their UI string overrides',
    verbs: {
      list: {
        op: 'Org_list',
        about: 'List your organizations',
        columns: ['id', 'slug', 'name', 'role'],
      },
      get: { op: 'Org_get', about: 'Get one organization (id or slug)', args: ['orgId'] },
      create: { op: 'Org_create', about: 'Create an organization', args: ['name'] },
      update: { op: 'Org_update', about: 'Update an organization', args: ['orgId'] },
      delete: {
        op: 'Org_remove',
        about: 'Delete an organization',
        args: ['orgId'],
        destructive: true,
      },
      'deepl status': { op: 'Deepl_status', about: 'Whether a DeepL key is connected' },
      'deepl set': {
        op: 'Deepl_setKey',
        about: 'Connect the organization’s own DeepL key (what every auto-translate uses)',
        args: ['apiKey'],
      },
      'deepl clear': {
        op: 'Deepl_clear',
        about: 'Disconnect the DeepL key',
        destructive: true,
      },
      'strings list': {
        op: 'TranslationOverride_list',
        about: 'The organization’s own wording for interface strings (--locale es)',
        columns: ['locale', 'key', 'value', 'updatedAt'],
      },
      'strings set': {
        op: 'TranslationOverride_set',
        about: 'Override one interface string in one language',
        args: ['locale', 'key', 'value...'],
      },
      'strings remove': {
        op: 'TranslationOverride_remove',
        about: 'Drop an override (readers see the built-in wording again)',
        args: ['locale', 'key'],
        extraQuery: ['locale', 'key'],
        destructive: true,
      },
    },
  },
  {
    name: 'members',
    noun: 'member',
    about: 'people in an organization',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Member_list',
        about: 'List members',
        columns: ['userId', 'email', 'name', 'role', 'createdAt'],
      },
      update: { op: 'Member_update', about: 'Change a member’s role (--role)', args: ['userId'] },
      remove: {
        op: 'Member_remove',
        about: 'Remove a member',
        args: ['userId'],
        destructive: true,
      },
      'sign-out': {
        op: 'Member_revokeSessions',
        about: 'End every session a member has open',
        args: ['userId'],
        destructive: true,
      },
      reassign: {
        op: 'Member_reassignContent',
        about: 'Hand everything a member wrote to someone else',
        args: ['userId', 'targetUserId'],
      },
    },
  },
  {
    name: 'invites',
    noun: 'invite',
    about: 'invitations: sent, bulk, shareable links, and the ones waiting for you',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Member_invites',
        about: 'List pending invites',
        columns: ['id', 'email', 'role', 'expiresAt'],
      },
      create: { op: 'Member_invite', about: 'Invite someone (--role)', args: ['email'] },
      bulk: {
        op: 'Member_bulkInvite',
        about: 'Invite many at once (a,b,c or --csv; --role)',
        args: ['emails'],
      },
      revoke: {
        op: 'Member_revokeInvite',
        about: 'Revoke an invite',
        args: ['inviteId'],
        destructive: true,
      },
      'links list': {
        op: 'Member_listInviteLinks',
        about: 'Shareable invite links',
        columns: ['id', 'role', 'uses', 'maxUses', 'expiresAt'],
      },
      'links create': {
        op: 'Member_createInviteLink',
        about: 'Make a link anyone can join with (--role, --maxUses, --expiresInDays)',
      },
      'links revoke': {
        op: 'Member_revokeInviteLink',
        about: 'Turn a link off',
        args: ['linkId'],
        destructive: true,
      },
      pending: {
        op: 'Invite_pending',
        about: 'Invitations waiting for YOU',
        columns: ['id', 'orgName', 'role', 'expiresAt'],
      },
      accept: { op: 'Invite_acceptPending', about: 'Accept one of yours', args: ['inviteId'] },
      redeem: {
        op: 'Invite_accept',
        about: 'Accept an invite by the token in its email',
        args: ['token'],
      },
      join: {
        op: 'Invite_acceptLink',
        about: 'Join through a shareable link’s token',
        args: ['token'],
      },
    },
  },
  {
    name: 'groups',
    noun: 'group',
    about: 'groups of members: grants, flair, join requests',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Group_list',
        about: 'List groups',
        columns: ['id', 'name', 'visibility', 'joinPolicy', 'memberCount'],
      },
      get: { op: 'Group_get', about: 'Get one group', args: ['groupId'] },
      create: {
        op: 'Group_create',
        about: 'Create a group (--visibility, --joinPolicy)',
        args: ['name'],
      },
      update: { op: 'Group_update', about: 'Update a group', args: ['groupId'] },
      delete: { op: 'Group_remove', about: 'Delete a group', args: ['groupId'], destructive: true },
      'members add': {
        op: 'Group_addMember',
        about: 'Add a member (--isManager true)',
        args: ['groupId', 'userId'],
      },
      'members remove': {
        op: 'Group_removeMember',
        about: 'Remove a member',
        args: ['groupId', 'userId'],
        destructive: true,
      },
      join: { op: 'Group_join', about: 'Join a group (or ask to)', args: ['groupId'] },
      leave: { op: 'Group_leave', about: 'Leave a group', args: ['groupId'] },
      'requests list': {
        op: 'Group_requests',
        about: 'Requests to join',
        args: ['groupId'],
        columns: ['id', 'userId', 'createdAt'],
      },
      'requests review': {
        op: 'Group_review',
        about: 'Approve or reject a request (approve|reject)',
        args: ['groupId', 'requestId', 'action'],
      },
    },
  },
  {
    name: 'roles',
    noun: 'role',
    about: 'custom roles: named sets of capabilities',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'CustomRole_list',
        about: 'List custom roles',
        columns: ['id', 'name', 'capabilities'],
      },
      create: {
        op: 'CustomRole_create',
        about: 'Create a role (--capabilities docs.read,docs.write)',
        args: ['name'],
      },
      update: {
        op: 'CustomRole_update',
        about: 'Rename it or change its capabilities',
        args: ['id'],
      },
      delete: { op: 'CustomRole_remove', about: 'Delete a role', args: ['id'], destructive: true },
    },
  },
  {
    name: 'service-accounts',
    aliases: ['bots'],
    noun: 'service account',
    about: 'non-human members and the tokens they run on',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'ServiceAccount_list',
        about: 'List service accounts',
        columns: ['id', 'name', 'username', 'role', 'createdAt'],
      },
      create: { op: 'ServiceAccount_create', about: 'Create one (--role EDITOR)', args: ['name'] },
      rename: {
        op: 'ServiceAccount_rename',
        about: 'Rename it (--username)',
        args: ['id', 'name'],
      },
      revoke: {
        op: 'ServiceAccount_revoke',
        about: 'Remove it and every token it holds',
        args: ['id'],
        destructive: true,
      },
      'tokens list': {
        op: 'ServiceAccount_tokens',
        about: 'Its tokens',
        args: ['id'],
        columns: ['id', 'name', 'scopes', 'lastUsedAt', 'expiresAt'],
      },
      'tokens create': {
        op: 'ServiceAccount_mint',
        about: 'Mint a token (--scopes read,write; shown once)',
        args: ['id', 'name'],
      },
      'tokens revoke': {
        op: 'ServiceAccount_revokeToken',
        about: 'Revoke one token',
        args: ['id', 'tokenId'],
        destructive: true,
      },
    },
  },
  {
    name: 'tokens',
    aliases: ['pats'],
    noun: 'token',
    about: 'your personal access tokens',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Pat_list',
        about: 'List tokens',
        columns: ['id', 'name', 'scopes', 'lastUsedAt', 'expiresAt'],
      },
      scopes: { op: 'Pat_scopes', about: 'The scopes a token can carry' },
      create: {
        op: 'Pat_create',
        about: 'Mint a token (--scopes read,write; shown once)',
        args: ['name'],
      },
      rotate: {
        op: 'Pat_rotate',
        about: 'Rotate a token (--graceMinutes)',
        args: ['id'],
        lookup: { id: { listOp: 'Pat_list', match: ['name'] } },
      },
      rename: {
        op: 'Pat_rename',
        about: 'Rename a token',
        args: ['id', 'name'],
        lookup: { id: { listOp: 'Pat_list', match: ['name'] } },
      },
      revoke: {
        op: 'Pat_revoke',
        about: 'Revoke a token',
        args: ['id'],
        destructive: true,
        lookup: { id: { listOp: 'Pat_list', match: ['name'] } },
      },
    },
  },
  {
    name: 'webhooks',
    noun: 'webhook',
    about: 'webhook endpoints, their deliveries, and replays',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Webhook_list',
        about: 'List webhooks',
        columns: ['id', 'url', 'events', 'active', 'format'],
      },
      events: { op: 'Webhook_events', about: 'The event names a webhook can subscribe to' },
      create: {
        op: 'Webhook_create',
        about: 'Create a webhook (--events a,b; the secret is shown once)',
        args: ['url'],
      },
      update: { op: 'Webhook_update', about: 'Update a webhook', args: ['webhookId'] },
      delete: {
        op: 'Webhook_remove',
        about: 'Delete a webhook',
        args: ['webhookId'],
        destructive: true,
      },
      test: { op: 'Webhook_ping', about: 'Send a test delivery', args: ['webhookId'] },
      'rotate-secret': {
        op: 'Webhook_rotate',
        about: 'Rotate the signing secret',
        args: ['webhookId'],
      },
      deliveries: {
        op: 'Webhook_deliveries',
        about: 'Recent deliveries',
        args: ['webhookId'],
        columns: ['id', 'event', 'status', 'attempts', 'createdAt'],
      },
      replay: {
        op: 'Webhook_replay',
        about: 'Re-send one delivery',
        args: ['webhookId', 'deliveryId'],
      },
    },
  },
  {
    name: 'extensions',
    noun: 'extension',
    about: 'installed remote-app extensions and the marketplace',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Extension_list',
        about: 'Installed extensions',
        columns: ['id', 'name', 'version', 'enabled'],
      },
      available: {
        op: 'Extension_available',
        about: 'What the marketplace offers',
        columns: ['slug', 'name', 'version', 'description'],
      },
      install: {
        op: 'Extension_install',
        about: 'Install from a manifest URL (or --manifest @m.json)',
        args: ['manifestUrl'],
      },
      update: {
        op: 'Extension_update',
        about: 'Change its config, events or --enabled',
        args: ['id'],
      },
      uninstall: {
        op: 'Extension_uninstall',
        about: 'Uninstall it',
        args: ['id'],
        destructive: true,
      },
      test: { op: 'Extension_test', about: 'Send it a test event', args: ['id'] },
      deliveries: {
        op: 'Extension_deliveries',
        about: 'What was sent to it',
        args: ['id'],
        columns: ['id', 'event', 'status', 'createdAt'],
      },
      rotate: { op: 'Extension_rotate', about: 'Rotate its signing secret', args: ['id'] },
      upgrade: { op: 'Extension_upgrade', about: 'Move to the newest manifest', args: ['id'] },
    },
  },
  {
    name: 'audit',
    noun: 'audit entry',
    about: 'the organization’s audit log',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Audit_list',
        about: 'Who did what (--action, --actorUserId, --from, --to)',
        columns: ['createdAt', 'action', 'actorUserId', 'targetType', 'targetId'],
      },
      actions: { op: 'Audit_actions', about: 'The action names the log records' },
      export: {
        op: 'Audit_exportCsv',
        about: 'The log as CSV (same filters)',
        download: 'audit.csv',
      },
    },
  },
];
