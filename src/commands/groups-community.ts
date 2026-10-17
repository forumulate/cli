import type { GroupDef, VerbDef } from './resource';

/**
 * The topic-engine spaces — blog, forum, changelog, roadmap — which share
 * one shape of routes, plus each one's per-piece translations.
 *
 * Release notes from CI and a post from a script are the workflows; the
 * moderation verbs (pin, state, flags, bulk) are what a community manager
 * scripts once a forum is big enough to need it.
 */

/** blog, forum and changelog share one engine and one shape of routes. */
function surface(
  name: string,
  piece: string,
  ops: {
    list: string;
    get: string;
    create: string;
    update: string;
    delete: string;
    publish?: string;
  },
  about: string,
  more: Record<string, VerbDef>,
): GroupDef {
  const id = `${piece}Id`;
  return {
    name,
    noun: piece,
    about,
    defaultVerb: 'list',
    verbs: {
      list: {
        op: ops.list,
        about: `List ${about}`,
        columns: ['id', 'slug', 'title', 'state', 'publishedAt'],
      },
      get: { op: ops.get, about: `Get one ${piece}`, args: [id] },
      create: {
        op: ops.create,
        about: `Create a ${piece} (--title, --file post.md for the body)`,
        args: ['title'],
        markdown: 'markdown',
        publishOp: ops.publish,
      },
      update: {
        op: ops.update,
        about: `Update a ${piece} (--file post.md replaces the body)`,
        args: [id],
        markdown: 'markdown',
      },
      ...(ops.publish
        ? { publish: { op: ops.publish, about: `Publish a ${piece}`, args: [id] } }
        : {}),
      delete: { op: ops.delete, about: `Delete a ${piece}`, args: [id], destructive: true },
      ...more,
    },
  };
}

/**
 * `<group> translations list|get|put|remove|auto` — one piece's language
 * twins through the kind's own door. `translations pull|push|auto` is the
 * whole-space workflow over these same routes.
 */
export function translationVerbs(
  id: string,
  ops: { list: string; get?: string; put: string; remove: string; auto: string },
): Record<string, VerbDef> {
  return {
    'translations list': {
      op: ops.list,
      about: 'Every language of one piece, and each one’s state',
      args: [id],
      columns: ['code', 'locale', 'title', 'published', 'stale', 'origin'],
    },
    ...(ops.get
      ? {
          'translations get': {
            op: ops.get,
            about: 'One translation',
            args: [id, 'locale'],
          },
        }
      : {}),
    'translations put': {
      op: ops.put,
      about: 'Write one translation by hand (--title; --file es.md for the body)',
      args: [id, 'locale'],
      markdown: 'markdown',
    },
    'translations remove': {
      op: ops.remove,
      about: 'Remove one translation (readers fall back to the original)',
      args: [id, 'locale'],
      destructive: true,
    },
    'translations auto': {
      op: ops.auto,
      about: 'Machine-translate with YOUR provider (--force, --published)',
      args: [id, 'locale'],
    },
  };
}

const T = 'topicId';

export const COMMUNITY_GROUPS: GroupDef[] = [
  surface(
    'blog',
    'topic',
    {
      list: 'Blog_list',
      get: 'Blog_get',
      create: 'Blog_create',
      update: 'Blog_update',
      delete: 'Blog_remove',
      publish: 'Blog_publish',
    },
    'articles in a blog space',
    {
      search: { op: 'Blog_search', about: 'Search the blog’s articles', args: ['q...'] },
      tags: { op: 'Blog_tags', about: 'Tags in use', columns: ['tag', 'count'] },
      bookmarks: { op: 'Blog_bookmarks', about: 'Articles you bookmarked' },
      bookmark: { op: 'Blog_bookmark', about: 'Bookmark an article', args: [T] },
      settings: { op: 'Blog_getSettings', about: 'Who can post, comment moderation, reactions' },
      configure: { op: 'Blog_updateSettings', about: 'Change them (--whoCanPost, --defaultSort)' },
      schedule: {
        op: 'Blog_schedule',
        about: 'Publish at a time (ISO 8601)',
        args: [T, 'publishAt'],
      },
      unschedule: { op: 'Blog_unschedule', about: 'Cancel the schedule', args: [T] },
      state: {
        op: 'Blog_setState',
        about: 'DRAFT | PUBLISHED | CLOSED | ARCHIVED',
        args: [T, 'state'],
      },
      pin: { op: 'Blog_pin', about: 'Pin or unpin (true|false)', args: [T, 'pinned'] },
      authors: {
        op: 'Blog_setAuthors',
        about: 'Set the bylines (userIds a,b)',
        args: [T, 'userIds'],
      },
      comments: {
        op: 'Blog_setComments',
        about: 'Turn comments on or off (true|false)',
        args: [T, 'enabled'],
      },
      reply: {
        op: 'Blog_reply',
        about: 'Comment on an article (--file reply.md)',
        args: [T, 'markdown...'],
        markdown: 'markdown',
      },
      recover: { op: 'Blog_recoverArticle', about: 'Restore a deleted article', args: [T] },
      'slugs list': {
        op: 'Blog_slugHistory',
        about: 'Old slugs that still redirect to it',
        args: [T],
      },
      ...translationVerbs(T, {
        list: 'BlogPostTranslation_list',
        get: 'BlogPostTranslation_get',
        put: 'BlogPostTranslation_put',
        remove: 'BlogPostTranslation_remove',
        auto: 'BlogPostTranslation_auto',
      }),
    },
  ),
  surface(
    'forum',
    'topic',
    {
      list: 'Forum_list',
      get: 'ForumTopics_get',
      create: 'ForumTopics_create',
      update: 'ForumTopicEdit_update',
      delete: 'ForumTopicEdit_remove',
    },
    'topics in a forum space',
    {
      reply: {
        op: 'ForumTopics_reply',
        about: 'Reply to a topic (--file reply.md)',
        args: [T, 'markdown...'],
        markdown: 'markdown',
      },
      'reply-as-topic': {
        op: 'ForumTopics_replyAsLinkedTopic',
        about: 'Answer a post with a new linked topic (--title)',
        args: [T, 'postId'],
        markdown: 'markdown',
      },
      timeline: { op: 'ForumTopics_timeline', about: 'A topic’s timeline', args: [T] },
      related: { op: 'ForumTopics_related', about: 'Related topics', args: [T] },
      banner: { op: 'ForumTopics_banner', about: 'The forum’s banner topic' },
      wiki: {
        op: 'ForumTopics_setWiki',
        about: 'Make a post editable by everyone (true|false)',
        args: ['postId', 'wiki'],
      },
      tags: { op: 'Forum_tags', about: 'Tags in use', columns: ['tag', 'count'] },
      settings: { op: 'Forum_getSettings', about: 'Who can post, moderation, votes, reactions' },
      configure: { op: 'Forum_updateSettings', about: 'Change them (--whoCanPost, --postVotes)' },
      flags: {
        op: 'Forum_flags',
        about: 'The flag queue',
        columns: ['id', 'reason', 'postId', 'createdAt'],
      },
      'flags resolve': {
        op: 'Forum_resolveFlag',
        about: 'Resolve a flag (dismiss|hide)',
        args: ['flagId', 'action'],
      },
      'flags review': {
        op: 'Forum_reviewFlag',
        about: 'Review a flag through the queue’s actions',
        args: ['flagId', 'action'],
      },
      bulk: {
        op: 'Forum_bulkModerate',
        about: 'Act on many topics (topicIds a,b; close|archive|pin|retag|delete|…)',
        args: ['action', 'topicIds'],
      },
      'read mark': {
        op: 'Forum_markRead',
        about: 'Mark a topic read up to a post number',
        args: [T, 'postNumber'],
      },
      'read time': {
        op: 'Forum_readTime',
        about: 'Record reading time (seconds)',
        args: [T, 'seconds'],
      },
      'notify space': { op: 'Forum_spaceLevel', about: 'Your notification level for the forum' },
      'notify set': {
        op: 'Forum_setSpaceLevel',
        about: 'Set it (watching|tracking|normal|muted)',
        args: ['level'],
      },
      'notify topic': {
        op: 'Forum_setTopicLevel',
        about: 'Your level for one topic',
        args: [T, 'level'],
      },
      'subscriptions tags': { op: 'Forum_tagSubscriptions', about: 'Tags you follow' },
      'subscriptions tag': {
        op: 'Forum_setTagSubscription',
        about: 'Follow a tag at a level',
        args: ['tag', 'level'],
      },
      'subscriptions categories': {
        op: 'Forum_categorySubscriptions',
        about: 'Categories you follow',
      },
      'subscriptions category': {
        op: 'Forum_setCategorySubscription',
        about: 'Follow a category at a level',
        args: ['categoryId', 'level'],
      },
      'polls add': {
        op: 'ForumTopics_addPoll',
        about: 'Add a poll (--options a,b; --allowMultiple)',
        args: [T, 'question...'],
      },
      'polls vote': {
        op: 'ForumTopics_votePoll',
        about: 'Vote (optionIds a,b)',
        args: ['pollId', 'optionIds'],
      },
      'polls voters': { op: 'ForumTopics_pollVoters', about: 'Who voted', args: ['pollId'] },
      'polls close': { op: 'ForumTopics_closePoll', about: 'Close a poll', args: ['pollId'] },
      'polls reopen': { op: 'ForumTopics_reopenPoll', about: 'Reopen a poll', args: ['pollId'] },
      'polls remove': {
        op: 'ForumTopics_removePoll',
        about: 'Remove a poll',
        args: ['pollId'],
        destructive: true,
      },
      ...translationVerbs(T, {
        list: 'ForumTopicTranslation_list',
        get: 'ForumTopicTranslation_get',
        put: 'ForumTopicTranslation_put',
        remove: 'ForumTopicTranslation_remove',
        auto: 'ForumTopicTranslation_auto',
      }),
    },
  ),
  surface(
    'changelog',
    'release',
    {
      list: 'Changelog_list',
      get: 'Changelog_get',
      create: 'Changelog_create',
      update: 'Changelog_update',
      delete: 'Changelog_remove',
      publish: 'Changelog_publish',
    },
    'releases in a changelog space',
    {
      compile: {
        op: 'Changelog_compile',
        about: 'Release notes compiled from merged changes (--since)',
      },
      stats: { op: 'Changelog_widgetStats', about: 'The in-app widget’s reach (--days)' },
      schedule: {
        op: 'Changelog_schedule',
        about: 'Publish at a time (ISO 8601)',
        args: ['releaseId', 'publishAt'],
      },
      unschedule: { op: 'Changelog_unschedule', about: 'Cancel the schedule', args: ['releaseId'] },
      ...translationVerbs('releaseId', {
        list: 'ReleaseTranslation_list',
        get: 'ReleaseTranslation_get',
        put: 'ReleaseTranslation_put',
        remove: 'ReleaseTranslation_remove',
        auto: 'ReleaseTranslation_auto',
      }),
    },
  ),
  {
    name: 'roadmap',
    noun: 'idea',
    about: 'a roadmap space: ideas, votes, statuses, merges',
    defaultVerb: 'board',
    verbs: {
      board: {
        op: 'Roadmap_board',
        about: 'The board',
        columns: ['id', 'title', 'status', 'votes'],
      },
      get: { op: 'Roadmap_get', about: 'One idea', args: [T] },
      submit: {
        op: 'Roadmap_submit',
        about: 'Submit an idea (--file idea.md)',
        args: ['title'],
        markdown: 'markdown',
      },
      update: { op: 'Roadmap_update', about: 'Edit title, tags, pinned, featured', args: [T] },
      status: {
        op: 'Roadmap_setStatus',
        about: 'Move it (--message tells the voters)',
        args: [T, 'status'],
      },
      vote: { op: 'Roadmap_vote', about: 'Vote for it', args: [T] },
      comment: {
        op: 'Roadmap_comment',
        about: 'Comment (--file c.md)',
        args: [T, 'markdown...'],
        markdown: 'markdown',
      },
      merge: {
        op: 'Roadmap_merge',
        about: 'Merge it into another idea',
        args: [T, 'canonicalId'],
        destructive: true,
      },
      'proxy-votes list': {
        op: 'Roadmap_proxyVotes',
        about: 'Votes recorded for customers',
        args: [T],
      },
      'proxy-votes add': {
        op: 'Roadmap_recordProxyVote',
        about: 'Record a vote on a customer’s behalf (--importance)',
        args: [T, 'name...'],
      },
      'proxy-votes remove': {
        op: 'Roadmap_removeProxyVote',
        about: 'Remove one',
        args: [T, 'voteId'],
        destructive: true,
      },
    },
  },
];
