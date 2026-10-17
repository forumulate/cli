import type { GroupDef } from './resource';

/**
 * The headless CMS lifecycle a CI pipeline runs: libraries (members, locales,
 * model, delivery keys), entries (fields, locks, locale twins, trash), media,
 * releases (schedule, publish, roll back) and sandbox environments.
 *
 * `content pull|push` and `import` move the MODEL; these move the content.
 */
export const CONTENT_GROUPS: GroupDef[] = [
  {
    name: 'libraries',
    noun: 'library',
    about: 'headless CMS content libraries: members, locales, model and delivery keys',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'ContentLibrary_list',
        about: 'List libraries',
        columns: ['id', 'slug', 'name', 'createdAt'],
      },
      get: { op: 'ContentLibrary_get', about: 'Get one library', args: ['libraryId'] },
      create: {
        op: 'ContentLibrary_create',
        about: 'Create a library (--slug, --template)',
        args: ['name'],
      },
      update: { op: 'ContentLibrary_update', about: 'Update a library', args: ['libraryId'] },
      delete: {
        op: 'ContentLibrary_remove',
        about: 'Delete a library',
        args: ['libraryId'],
        destructive: true,
      },
      'members list': {
        op: 'ContentLibrary_listMembers',
        about: 'Who has a grant on the library',
        columns: ['userId', 'email', 'role', 'effect'],
      },
      'members add': {
        op: 'ContentLibrary_putMember',
        about: 'Grant someone a role here (--role, --effect DENY)',
        args: ['userId'],
      },
      'members remove': {
        op: 'ContentLibrary_removeMember',
        about: 'Remove a grant',
        args: ['userId'],
        destructive: true,
      },
      'locales list': {
        op: 'ContentLocales_list',
        about: 'Declared languages, the source and fallbacks',
        columns: ['code', 'label', 'source'],
      },
      'locales add': {
        op: 'ContentLocales_add',
        about: 'Declare a language',
        args: ['code', 'label...'],
      },
      'locales relabel': {
        op: 'ContentLocales_relabel',
        about: 'Rename a language',
        args: ['code', 'label...'],
      },
      'locales settings': {
        op: 'ContentLocales_settings',
        about:
          'Source language and fallbacks (--sourceLocale en, --field localeFallbacks.de:=["en"])',
      },
      'locales remove': {
        op: 'ContentLocales_remove',
        about: 'Remove a language',
        args: ['code'],
        destructive: true,
      },
      'model get': { op: 'ContentModel_get', about: 'The content model' },
      'model put': {
        op: 'ContentModel_put',
        about: 'Replace or patch the model (--data @model.json); `content push` diffs first',
      },
      'model versions': {
        op: 'ContentModel_versions',
        about: 'Earlier versions of the model',
        columns: ['version', 'authorId', 'createdAt'],
      },
      'keys list': {
        op: 'DeliveryKeys_list',
        about: 'List delivery keys',
        columns: ['id', 'name', 'kind', 'lastUsedAt', 'expiresAt'],
      },
      'keys create': {
        op: 'DeliveryKeys_create',
        about: 'Create a key (--kind delivery|publishable|preview; shown once)',
        args: ['name'],
      },
      'keys update': {
        op: 'DeliveryKeys_update',
        about: 'Rename or narrow a key (--origins, --contentTypes, --locales)',
        args: ['keyId'],
      },
      'keys rotate': { op: 'DeliveryKeys_rotate', about: 'Rotate a key', args: ['keyId'] },
      'keys revoke': {
        op: 'DeliveryKeys_revoke',
        about: 'Revoke a key',
        args: ['keyId'],
        destructive: true,
      },
    },
  },
  {
    name: 'entries',
    noun: 'entry',
    about: 'a library’s entries: fields, publish, locks, locale twins, trash',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'ContentStudio_list',
        about: 'Entries of one content type (--where, --sort)',
        args: ['type'],
        columns: ['id', 'slug', 'title', 'status', 'updatedAt'],
      },
      types: {
        op: 'ContentStudio_types',
        about: 'The content types, with how many entries each has',
        columns: ['type', 'label', 'count'],
      },
      get: { op: 'LibraryItem_read', about: 'Get one entry', args: ['itemId'] },
      create: {
        op: 'LibraryItem_create',
        about: 'Create an entry (--preset <type>; --file body.md)',
        args: ['title'],
        markdown: 'body',
        publishOp: 'LibraryItem_publish',
      },
      update: { op: 'LibraryItem_patch', about: 'Change title, slug, params', args: ['itemId'] },
      lookup: {
        op: 'LibraryItem_lookup',
        about: 'Find entries by slug or key (keys a,b)',
        args: ['keys'],
      },
      fields: { op: 'LibraryItem_fields', about: 'Its field values', args: ['itemId'] },
      'fields set': {
        op: 'LibraryItem_setFields',
        about: 'Set field values (--field fields.price=10, --data @f.json)',
        args: ['itemId'],
      },
      values: {
        op: 'EntryFields_read',
        about: 'Its fields as the editor sees them (with the version to patch against)',
        args: ['entryId'],
      },
      patch: {
        op: 'EntryFields_patch',
        about: 'Patch fields by JSON-pointer ops (--data @ops.json)',
        args: ['entryId'],
      },
      publish: { op: 'LibraryItem_publish', about: 'Publish an entry', args: ['itemId'] },
      delete: {
        op: 'LibraryItem_remove',
        about: 'Delete an entry (to the trash; --force if referenced)',
        args: ['itemId'],
        destructive: true,
      },
      bulk: {
        op: 'ContentStudio_runBulk',
        about: 'publish | unpublish | delete | localeCopy many entries (entryIds a,b; --locale)',
        args: ['action', 'entryIds'],
      },
      trash: {
        op: 'LibraryItem_trash',
        about: 'Entries in the trash',
        columns: ['id', 'title', 'deletedAt'],
      },
      restore: {
        op: 'LibraryItem_restore',
        about: 'Bring one back from the trash',
        args: ['itemId'],
      },
      lock: { op: 'EntryFields_lock', about: 'Who is editing it right now', args: ['entryId'] },
      'lock take': {
        op: 'EntryFields_takeLock',
        about: 'Take the edit lock (--takeOver true)',
        args: ['entryId'],
      },
      'lock renew': {
        op: 'EntryFields_heartbeat',
        about: 'Keep holding the lock',
        args: ['entryId'],
      },
      'lock release': {
        op: 'EntryFields_releaseLock',
        about: 'Let go of the lock',
        args: ['entryId'],
      },
      'locale get': {
        op: 'ContentEntryLocales_read',
        about: 'Its fields in one language (--fallback, --draft)',
        args: ['entryId', 'locale'],
      },
      'locale set': {
        op: 'ContentEntryLocales_write',
        about: 'Write its draft twin in a language (--data @fields.json: {fields:{…}})',
        args: ['entryId', 'locale'],
      },
    },
  },
  {
    name: 'media',
    noun: 'media file',
    about: 'a library’s media: upload, alt text, focal point, where it is used',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'LibraryMedia_list',
        about: 'List media (--type, --search, --missingAlt true)',
        columns: ['id', 'filename', 'contentType', 'alt', 'url'],
      },
      upload: { op: 'LibraryMedia_upload', about: 'Upload a file', args: ['file'], upload: 'file' },
      update: {
        op: 'LibraryMedia_update',
        about: 'Alt text, caption, focal point, folder, tags',
        args: ['assetId'],
      },
      'bulk update': {
        op: 'LibraryMedia_bulkUpdate',
        about: 'Change many at once (--data @updates.json)',
      },
      'alt-text': {
        op: 'LibraryMedia_suggestAltText',
        about: 'Suggest alt text for pictures (assetIds a,b; your AI provider)',
        args: ['assetIds'],
      },
      'used-in': { op: 'LibraryMedia_usedIn', about: 'Entries that use it', args: ['assetId'] },
      delete: {
        op: 'LibraryMedia_remove',
        about: 'Delete a file',
        args: ['assetId'],
        destructive: true,
      },
    },
  },
  {
    name: 'releases',
    noun: 'release',
    about: 'content releases: a set of drafts published together, on a schedule, reversibly',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Releases_list',
        about: 'List releases',
        columns: ['id', 'name', 'state', 'scheduledFor', 'itemCount'],
      },
      get: { op: 'Releases_get', about: 'Get one release and its items', args: ['releaseId'] },
      create: { op: 'Releases_create', about: 'Start a release (--description)', args: ['name'] },
      rename: {
        op: 'Releases_update',
        about: 'Rename it (--description)',
        args: ['releaseId', 'name'],
      },
      delete: {
        op: 'Releases_remove',
        about: 'Delete a release',
        args: ['releaseId'],
        destructive: true,
      },
      candidates: {
        op: 'Releases_candidates',
        about: 'Drafts you could add (--q, --kind)',
        columns: ['kind', 'id', 'title', 'updatedAt'],
      },
      add: {
        op: 'Releases_addItem',
        about: 'Add a draft (--kind entry --libraryId … --entryId …, or --kind page --pageId …)',
        args: ['releaseId'],
      },
      remove: {
        op: 'Releases_removeItem',
        about: 'Take an item out',
        args: ['releaseId', 'itemId'],
      },
      schedule: {
        op: 'Releases_schedule',
        about: 'Publish at a time (ISO 8601)',
        args: ['releaseId', 'publishAt'],
      },
      unschedule: { op: 'Releases_unschedule', about: 'Cancel the schedule', args: ['releaseId'] },
      preview: {
        op: 'Releases_preview',
        about: 'A preview link for the release',
        args: ['releaseId'],
      },
      publish: { op: 'Releases_publish', about: 'Publish it now', args: ['releaseId'] },
      rollback: {
        op: 'Releases_rollback',
        about: 'Put back what was live before it',
        args: ['releaseId'],
        destructive: true,
      },
    },
  },
  {
    name: 'environments',
    aliases: ['envs'],
    noun: 'environment',
    about: 'sandbox copies of a library: fork, compare, promote',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Environments_list',
        about: 'A library’s sandboxes',
        columns: ['id', 'slug', 'name', 'createdAt'],
      },
      fork: {
        op: 'Environments_fork',
        about: 'Fork the library into a sandbox (--slug, --includeContent true)',
        args: ['name'],
      },
      compare: {
        op: 'Environments_compare',
        about: 'How a sandbox’s model differs from its source (--library <sandbox>)',
      },
      promote: {
        op: 'Environments_promote',
        about: 'Make the sandbox’s model the source’s (--library <sandbox>)',
        destructive: true,
      },
    },
  },
];
