import type { GroupDef } from './resource';

/**
 * The docs-as-code loop: items (any space's pieces), the docs-specific page
 * operations (revisions, schedule, rollback, checkpoints, trash), collections,
 * versions and change requests.
 *
 * `items` is the universal model every space type answers; `docs` is what
 * only a docs space has. In a docs space a page id IS its item id, so
 * `items get <id>` and `docs history <id>` take the same id.
 */
export const DOCS_GROUPS: GroupDef[] = [
  {
    name: 'items',
    aliases: ['pages'],
    noun: 'item',
    about: 'the pieces in a space — pages, posts, topics — through the universal items API',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Item_list',
        about: 'List items, with where each one’s content lives',
        query: { include: 'sections,body' },
        columns: ['id', 'slug', 'title', 'status', 'contentIn', 'updatedAt'],
      },
      get: { op: 'Item_read', about: 'Get one item', args: ['itemId'] },
      content: { op: 'Item_getContent', about: 'Print an item’s content', args: ['itemId'] },
      create: {
        op: 'Item_create',
        about: 'Create an item (--file page.md: body, title and slug from front matter)',
        args: ['title'],
        markdown: 'body',
        publishOp: 'Item_publish',
      },
      update: {
        op: 'Item_patch',
        about: 'Update title/slug/params; --file page.md replaces the body',
        args: ['itemId'],
        markdown: 'body',
        contentOp: 'Item_putContent',
      },
      write: {
        op: 'Item_putContent',
        about: 'Replace the content (--file page.md, or --content @blocks.json)',
        args: ['itemId'],
        markdown: 'body',
      },
      section: {
        op: 'Item_putSection',
        about: 'Replace one section of a shaped piece (--file section.md)',
        args: ['itemId', 'key'],
        markdown: 'markdown',
      },
      fields: { op: 'Item_fields', about: 'The piece’s custom field values', args: ['itemId'] },
      'fields set': {
        op: 'Item_setFields',
        about: 'Set custom fields (--field fields.price=10, --data @f.json)',
        args: ['itemId'],
      },
      chunks: {
        op: 'Item_chunks',
        about: 'How retrieval splits it (the public chunk contract)',
        args: ['itemId'],
      },
      verify: { op: 'Item_verify', about: 'Mark it verified as still correct', args: ['itemId'] },
      publish: { op: 'Item_publish', about: 'Publish an item', args: ['itemId'] },
      delete: { op: 'Item_remove', about: 'Delete an item', args: ['itemId'], destructive: true },
    },
  },
  {
    name: 'docs',
    noun: 'page',
    about:
      'a docs space’s pages: revisions, publish, schedule, rollback, checkpoints, trash, import, search, locales',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Page_list',
        about: 'The page tree (--version, --locale)',
        columns: ['id', 'slug', 'title', 'parentId', 'publishedAt'],
      },
      inventory: {
        op: 'Page_inventory',
        about: 'Every page with its state, owner and freshness',
        columns: ['id', 'slug', 'title', 'state', 'updatedAt'],
      },
      get: { op: 'Page_getPage', about: 'Get one page (--include …)', args: ['pageId'] },
      update: { op: 'Page_update', about: 'Change its title or slug', args: ['pageId'] },
      meta: {
        op: 'Page_getMetadata',
        about: 'Its metadata (tags, SEO, layout, …)',
        args: ['pageId'],
      },
      'meta set': {
        op: 'Page_setMetadata',
        about: 'Set metadata (--seoTitle …, --tags a,b, --data @meta.json)',
        args: ['pageId'],
      },
      move: {
        op: 'Page_reorder',
        about: 'Move it (--parentId, --afterId, --collectionId)',
        args: ['pageId'],
      },
      duplicate: { op: 'Page_duplicate', about: 'Copy a page (--title, --slug)', args: ['pageId'] },
      save: {
        op: 'Revision_save',
        about: 'Save a new draft (--file page.md; --changeRequestId)',
        args: ['pageId'],
        markdown: 'body',
      },
      section: {
        op: 'Revision_putSection',
        about: 'Replace one section of the draft (--file section.md)',
        args: ['pageId', 'key'],
        markdown: 'markdown',
      },
      shape: {
        op: 'Revision_setShape',
        about: 'Give the page a shape preset',
        args: ['pageId', 'preset'],
      },
      draft: { op: 'Revision_draft', about: 'The current draft', args: ['pageId'] },
      published: { op: 'Revision_published', about: 'What readers see now', args: ['pageId'] },
      publish: {
        op: 'Revision_publish',
        about: 'Publish the draft (--editorial true, --editorialNote)',
        args: ['pageId'],
      },
      unpublish: { op: 'Page_unpublish', about: 'Take it off the site', args: ['pageId'] },
      history: {
        op: 'Revision_history',
        about: 'Its revisions',
        args: ['pageId'],
        columns: ['id', 'authorId', 'createdAt', 'publishedAt'],
      },
      diff: {
        op: 'Revision_diff',
        about: 'What a revision changed (--from <revisionId>)',
        args: ['pageId', 'revisionId'],
      },
      rollback: {
        op: 'Revision_rollback',
        about: 'Go back to a revision (--mode publish|draft)',
        args: ['pageId', 'revisionId'],
      },
      'checkpoints list': {
        op: 'Revision_checkpoints',
        about: 'Autosaved checkpoints',
        args: ['pageId'],
        columns: ['id', 'createdAt'],
      },
      'checkpoints get': {
        op: 'Revision_checkpoint',
        about: 'One checkpoint',
        args: ['pageId', 'checkpointId'],
      },
      'checkpoints restore': {
        op: 'Revision_restoreCheckpoint',
        about: 'Restore the draft to a checkpoint',
        args: ['pageId', 'checkpointId'],
      },
      'schedule get': {
        op: 'Revision_getSchedule',
        about: 'When it will publish',
        args: ['pageId'],
      },
      'schedule set': {
        op: 'Revision_schedule',
        about: 'Publish the draft at a time (ISO 8601)',
        args: ['pageId', 'publishAt'],
      },
      'schedule cancel': {
        op: 'Revision_cancelSchedule',
        about: 'Cancel a scheduled publish',
        args: ['pageId'],
      },
      delete: {
        op: 'Page_remove',
        about: 'Delete a page (to the trash)',
        args: ['pageId'],
        destructive: true,
      },
      restore: { op: 'Page_restore', about: 'Bring a page back from the trash', args: ['pageId'] },
      purge: {
        op: 'Page_purge',
        about: 'Delete a trashed page for good',
        args: ['pageId'],
        destructive: true,
      },
      'bulk delete': {
        op: 'Page_bulkDelete',
        about: 'Trash many pages (a,b,c or --collectionId)',
        args: ['ids'],
        destructive: true,
      },
      'bulk move': {
        op: 'Page_bulkMove',
        about: 'Move many pages (--collectionId, --parentId)',
        args: ['ids'],
      },
      'trash list': {
        op: 'Page_trash',
        about: 'Pages in the trash',
        columns: ['id', 'slug', 'title', 'deletedAt'],
      },
      'trash empty': {
        op: 'Page_emptyTrash',
        about: 'Delete the trash for good',
        destructive: true,
      },
      search: { op: 'Search_run', about: 'Search this docs space', args: ['q...'] },
      'import files': {
        op: 'Import_importFiles',
        about: 'Import Markdown files (--data @files.json: {files:[{name,content}]})',
      },
      'import zip': {
        op: 'Import_importZip',
        about: 'Import a zip of Markdown',
        args: ['file'],
        upload: 'file',
      },
      'import docx': {
        op: 'Import_importDocx',
        about: 'Import a Word document',
        args: ['file'],
        upload: 'file',
      },
      'import url': {
        op: 'Import_importUrl',
        about: 'Import from a git repository or site URL (--branch, --dryRun)',
        args: ['url'],
      },
      'import dedupe': {
        op: 'Import_dedupeTitles',
        about: 'Make duplicate imported titles unique (--dryRun true)',
      },
      'locales list': {
        op: 'Translation_list',
        about: 'The languages the space is written in',
        columns: ['code', 'label', 'isDefault'],
      },
      'locales add': {
        op: 'Translation_create',
        about: 'Add a language (seeds an unpublished twin of every page)',
        args: ['code', 'label...'],
      },
      'locales relabel': {
        op: 'Translation_update',
        about: 'Rename a language',
        args: ['code', 'label...'],
      },
      'locales remove': {
        op: 'Translation_remove',
        about: 'Remove a language (its translations go to the trash)',
        args: ['code'],
        destructive: true,
      },
    },
  },
  {
    name: 'collections',
    noun: 'collection',
    about: 'the groups a space’s pages are filed under',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Collection_list',
        about: 'List collections',
        columns: ['id', 'slug', 'name', 'position'],
      },
      get: { op: 'Collection_get', about: 'Get one collection', args: ['collectionId'] },
      create: { op: 'Collection_create', about: 'Create a collection (--slug)', args: ['name'] },
      update: { op: 'Collection_update', about: 'Update a collection', args: ['collectionId'] },
      delete: {
        op: 'Collection_remove',
        about: 'Delete a collection',
        args: ['collectionId'],
        destructive: true,
      },
      reorder: { op: 'Collection_reorder', about: 'Set the order (ids a,b,c)', args: ['ids'] },
      pages: {
        op: 'Collection_tree',
        about: 'Its page tree (--locale required, --version)',
        args: ['collectionId'],
        columns: ['id', 'slug', 'title', 'parentId'],
      },
      'pages create': {
        op: 'Collection_createPage',
        about: 'Create a page in it (--slug; --file page.md)',
        args: ['collectionId', 'title'],
        markdown: 'body',
      },
      'pages order': {
        op: 'Collection_order',
        about: 'Order its pages (pageIds a,b,c; --parentId)',
        args: ['collectionId', 'pageIds'],
      },
    },
  },
  {
    name: 'versions',
    noun: 'version',
    about: 'a docs space’s versions (v1, v2, …) and which one is canonical',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Version_list',
        about: 'List versions',
        columns: ['key', 'label', 'isDefault', 'archived'],
      },
      create: {
        op: 'Version_create',
        about: 'Create a version (--fromVersion to copy)',
        args: ['key', 'label...'],
      },
      update: {
        op: 'Version_update',
        about: 'Relabel, badge, banner, hide, archive',
        args: ['key'],
      },
      default: {
        op: 'Version_makeDefault',
        about: 'Make it the default; the old default becomes --retireAs',
        args: ['key'],
      },
      delete: { op: 'Version_remove', about: 'Delete a version', args: ['key'], destructive: true },
      settings: { op: 'Versioning_get', about: 'How versions are served (canonical, …)' },
      configure: { op: 'Versioning_set', about: 'Change how versions are served (--canonical)' },
    },
  },
  {
    name: 'change-requests',
    aliases: ['crs'],
    noun: 'change request',
    about: 'proposed docs changes: open, review, approve, merge',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'ChangeRequest_list',
        about: 'List change requests',
        columns: ['id', 'number', 'title', 'state', 'authorId', 'updatedAt'],
      },
      get: { op: 'ChangeRequest_get', about: 'Get one', args: ['crId'] },
      open: { op: 'ChangeRequest_create', about: 'Open a change request', args: ['title...'] },
      eligibility: { op: 'ChangeRequest_eligibility', about: 'Whether you may open one here' },
      pages: { op: 'ChangeRequest_pages', about: 'The pages it changes', args: ['crId'] },
      conflicts: {
        op: 'ChangeRequest_conflicts',
        about: 'Conflicts with the live pages',
        args: ['crId'],
      },
      blockers: {
        op: 'ChangeRequest_mergeBlockers',
        about: 'What stops it merging',
        args: ['crId'],
      },
      rebase: {
        op: 'ChangeRequest_rebase',
        about: 'Bring it up to date with live',
        args: ['crId'],
      },
      'request-review': {
        op: 'ChangeRequest_requestReview',
        about: 'Ask its reviewers to look',
        args: ['crId'],
      },
      'reviewers list': {
        op: 'ChangeRequest_listReviewers',
        about: 'Its reviewers',
        args: ['crId'],
      },
      'reviewers add': {
        op: 'ChangeRequest_addReviewers',
        about: 'Add reviewers (userIds a,b)',
        args: ['crId', 'userIds'],
      },
      'reviewers remove': {
        op: 'ChangeRequest_removeReviewer',
        about: 'Remove a reviewer',
        args: ['crId', 'reviewerId'],
      },
      review: {
        op: 'ChangeRequest_review',
        about: 'Leave a verdict (approved|changes_requested)',
        args: ['crId', 'verdict'],
      },
      approve: { op: 'ChangeRequest_approve', about: 'Approve it', args: ['crId'] },
      merge: { op: 'ChangeRequest_merge', about: 'Merge it into live (--force)', args: ['crId'] },
      close: { op: 'ChangeRequest_close', about: 'Close it without merging', args: ['crId'] },
      comments: { op: 'ChangeRequest_comments', about: 'Its discussion', args: ['crId'] },
      comment: {
        op: 'ChangeRequest_comment',
        about: 'Comment (--pageId, --parentCommentId)',
        args: ['crId', 'body...'],
      },
      'agent-review': {
        op: 'ChangeRequest_agentReview',
        about: 'Have the AI reviewer read it (your provider)',
        args: ['crId'],
      },
      'agent-run': {
        op: 'ChangeRequest_agentRun',
        about: 'Have the agent make a change in it',
        args: ['crId', 'instruction...'],
      },
      'rules get': { op: 'ChangeRequest_mergeRules', about: 'The space’s merge rules' },
      'rules set': {
        op: 'ChangeRequest_setMergeRules',
        about: 'Set them (--requiredApprovals 2, --requireAllReviewers true)',
      },
    },
  },
];
