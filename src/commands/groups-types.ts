import type { GroupDef } from './resource';
import { translationVerbs } from './groups-community';

/**
 * The other space types' own work: a status page (incidents from on-call
 * tooling, components, channels), events, courses, careers, and forms.
 */
const I = 'incidentId';

export const TYPE_GROUPS: GroupDef[] = [
  {
    name: 'status',
    noun: 'incident',
    about: 'a status space: incidents, components (monitors), channels, translations',
    defaultVerb: 'board',
    verbs: {
      board: { op: 'Status_board', about: 'The board: overall state, components, open incidents' },
      'incidents list': {
        op: 'Status_board',
        about: 'List incidents',
        pick: 'incidents',
        columns: ['id', 'title', 'state', 'severity', 'startedAt'],
      },
      'incidents create': {
        op: 'Status_createIncident',
        about: 'Open an incident (--state, --severity, --markdown)',
        args: ['title'],
        markdown: 'markdown',
      },
      'incidents update': {
        op: 'Status_updateIncident',
        about: 'Change an incident (--state resolved, …)',
        args: [I],
      },
      'incidents post': {
        op: 'Status_addIncidentUpdate',
        about: 'Post an update on an incident',
        args: [I, 'body...'],
      },
      'components list': {
        op: 'Status_monitors',
        about: 'List components (monitors)',
        columns: ['id', 'name', 'kind', 'state', 'url'],
      },
      'components create': {
        op: 'Status_addMonitor',
        about: 'Add a component (--url, --kind)',
        args: ['name'],
      },
      'components update': {
        op: 'Status_updateMonitor',
        about: 'Update a component',
        args: ['monitorId'],
      },
      'components delete': {
        op: 'Status_removeMonitor',
        about: 'Remove a component',
        args: ['monitorId'],
        destructive: true,
      },
      'groups get': { op: 'Status_getGroups', about: 'How components are grouped' },
      'groups set': { op: 'Status_setGroups', about: 'Regroup them (--data @groups.json)' },
      'channels list': {
        op: 'Status_listChannels',
        about: 'Where incidents are announced (Slack, webhook, …)',
        columns: ['id', 'kind', 'label', 'url'],
      },
      'channels add': {
        op: 'Status_addChannel',
        about: 'Announce somewhere new (--label)',
        args: ['kind', 'url'],
      },
      'channels remove': {
        op: 'Status_removeChannel',
        about: 'Stop announcing there',
        args: ['channelId'],
        destructive: true,
      },
      // FMU-F07: a maintenance window as a pipeline has it. `--key` makes a
      // retried job update its window instead of announcing a second one.
      maintenance: {
        op: 'StatusDepth_maintenance',
        about:
          'Schedule maintenance from CI (--from <iso> --to <iso> --components api,dashboard [--key $CI_RUN_ID] [--title …] [--markdown …])',
      },
      'templates list': {
        op: 'StatusTemplates_list',
        about: 'Saved incidents',
        columns: ['id', 'name', 'title', 'severity'],
      },
      'templates use': {
        op: 'StatusTemplates_use',
        about: 'Open an incident from a saved one',
        args: ['templateId'],
      },
      sla: {
        op: 'StatusDepth_slaReport',
        about: 'The uptime SLA report (--days 30 --target 99.9); --json for the PDF-ready sections',
        columns: ['name', 'uptime', 'met', 'budgetMinutes', 'downtimeMinutes'],
        pick: 'components',
      },
      'sla csv': {
        op: 'StatusDepth_slaReportCsv',
        about: 'The SLA report as CSV (--out sla.csv)',
        download: 'sla.csv',
      },
      'upstreams list': {
        op: 'StatusDepth_listUpstreams',
        about: 'The services this page depends on, with their live reading',
        pick: 'upstreams',
        columns: ['id', 'label', 'display', 'mirrorIncidents'],
      },
      'upstreams set': {
        op: 'StatusDepth_replaceUpstreams',
        about:
          'Replace them (--data @upstreams.json: [{label, source:{kind,url|org,space}, components, relation: upstream|product}])',
      },
      'mirror-grants list': {
        op: 'StatusDepth_listMirrorGrants',
        about: 'Which organizations may mirror this page while it is private, and how many pages do',
        pick: 'grants',
        columns: ['organizationId', 'slug', 'name', 'createdAt'],
      },
      'mirror-grants set': {
        op: 'StatusDepth_replaceMirrorGrants',
        about: 'Replace them (--data \'{"organizations":["acme-suite"]}\')',
      },
      'events list': {
        op: 'StatusDepth_listEvents',
        about: 'The private events feed (--open true for unacknowledged)',
        pick: 'events',
        columns: ['occurredAt', 'type', 'state', 'subject', 'title'],
      },
      'events post': {
        op: 'StatusEventsIngest_ingest',
        about: 'Post a private event (--id --type --title [--state failing]); the token must be an events key',
      },
      'event-keys list': {
        op: 'StatusDepth_listKeys',
        about: 'Events keys of this page',
        pick: 'keys',
        columns: ['id', 'name', 'hint', 'lastUsedAt', 'revokedAt'],
      },
      'event-keys create': {
        op: 'StatusDepth_mintKey',
        about: 'Mint an events key (status:write on this page)',
        args: ['name'],
      },
      'event-keys revoke': {
        op: 'StatusDepth_revokeKey',
        about: 'Revoke an events key',
        args: ['keyId'],
        destructive: true,
      },
      settings: { op: 'Status_getSettings', about: 'Auto-incidents, notifications, reminders' },
      configure: {
        op: 'Status_setSettings',
        about: 'Change them (--autoIncident true, --autoTranslate true)',
      },
      ...translationVerbs(I, {
        list: 'StatusTranslations_list',
        put: 'StatusTranslations_put',
        remove: 'StatusTranslations_remove',
        auto: 'StatusTranslations_auto',
      }),
      'translations machine': {
        op: 'StatusTranslations_machine',
        about: 'The older address of `translations auto` (--replace true), kept for scripts',
        args: [I, 'locale'],
      },
    },
  },
  {
    name: 'events',
    noun: 'event',
    about: 'an events space: events, duplicates, RSVPs',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Events_list',
        about: 'Upcoming events (--from, --to, --tag, --mode)',
        columns: ['id', 'handle', 'title', 'startsAt', 'state'],
      },
      manage: {
        op: 'Events_listAll',
        about: 'Every event, drafts and past ones included',
        columns: ['id', 'handle', 'title', 'startsAt', 'state'],
      },
      get: { op: 'Events_get', about: 'One event', args: ['handle'] },
      create: {
        op: 'Events_create',
        about: 'Create an event (--startsAt, --timezone, --location; --file about.md)',
        args: ['title'],
        markdown: 'description',
      },
      update: { op: 'Events_update', about: 'Change an event', args: ['handle'] },
      duplicate: {
        op: 'Events_duplicate',
        about: 'Copy an event to a new date (--startsAt)',
        args: ['handle'],
      },
      delete: {
        op: 'Events_remove',
        about: 'Delete an event',
        args: ['handle'],
        destructive: true,
      },
      rsvp: { op: 'Events_myRsvp', about: 'Your RSVP', args: ['handle'] },
      'rsvp set': {
        op: 'Events_rsvp',
        about: 'RSVP (going|interested|declined; --guests)',
        args: ['handle', 'status'],
      },
      'rsvp clear': { op: 'Events_clearRsvp', about: 'Withdraw your RSVP', args: ['handle'] },
    },
  },
  {
    name: 'course',
    noun: 'lesson',
    about: 'a course space: the outline and your progress',
    defaultVerb: 'outline',
    verbs: {
      outline: { op: 'Course_outline', about: 'Modules and lessons, with your progress' },
      enrol: { op: 'Course_enrol', about: 'Enrol (--tz Europe/Berlin)' },
      complete: {
        op: 'Course_complete',
        about: 'Mark a lesson done or not (true|false)',
        args: ['slug', 'completed'],
      },
      'progress merge': {
        op: 'Course_merge',
        about: 'Merge progress kept elsewhere (completed a,b)',
        args: ['completed'],
      },
    },
  },
  {
    name: 'careers',
    noun: 'application',
    about: 'a careers space: applications, pipeline, form, notes, ratings',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Careers_list',
        about: 'Applications (--status)',
        columns: ['id', 'name', 'email', 'role', 'status', 'createdAt'],
      },
      status: {
        op: 'Careers_setStatus',
        about: 'Move an application along the pipeline',
        args: ['id', 'status'],
      },
      assign: { op: 'Careers_assign', about: 'Give it to someone', args: ['id', 'assigneeId'] },
      replies: {
        op: 'Careers_replies',
        about: 'Emails exchanged with the applicant',
        args: ['id'],
      },
      reply: { op: 'Careers_reply', about: 'Email the applicant', args: ['id', 'body...'] },
      'notes list': { op: 'Careers_notes', about: 'Internal notes', args: ['id'] },
      'notes add': { op: 'Careers_addNote', about: 'Add a note', args: ['id', 'body...'] },
      'notes delete': {
        op: 'Careers_deleteNote',
        about: 'Delete a note',
        args: ['id', 'noteId'],
        destructive: true,
      },
      ratings: { op: 'Careers_ratings', about: 'The team’s ratings', args: ['id'] },
      rate: { op: 'Careers_rate', about: 'Rate an application', args: ['id', 'score'] },
      'pipeline get': { op: 'Careers_getPipeline', about: 'The pipeline stages' },
      'pipeline set': { op: 'Careers_setPipeline', about: 'Change them (--data @pipeline.json)' },
      'form get': { op: 'Careers_form', about: 'The application form' },
      'form set': { op: 'Careers_setForm', about: 'Change it (--data @form.json)' },
      eeo: { op: 'Careers_eeoSummary', about: 'The anonymous EEO summary' },
      export: {
        op: 'Careers_exportCsv',
        about: 'Every application as CSV',
        download: 'applications.csv',
      },
    },
  },
  {
    name: 'forms',
    noun: 'form',
    about: 'forms and their submissions',
    defaultVerb: 'list',
    verbs: {
      list: {
        op: 'Forms_list',
        about: 'List forms',
        columns: ['id', 'name', 'status', 'createdAt'],
      },
      get: { op: 'Forms_get', about: 'One form', args: ['formId'] },
      create: {
        op: 'Forms_create',
        about: 'Create a form (--data @form.json for fields)',
        args: ['name'],
      },
      update: { op: 'Forms_update', about: 'Change a form', args: ['formId'] },
      delete: { op: 'Forms_remove', about: 'Delete a form', args: ['formId'], destructive: true },
      submissions: {
        op: 'Forms_submissions',
        about: 'Its submissions (--spam true for the spam folder)',
        args: ['formId'],
        columns: ['id', 'createdAt', 'spam'],
      },
      export: {
        op: 'Forms_exportCsv',
        about: 'Its submissions as CSV',
        args: ['formId'],
        download: 'submissions.csv',
      },
      spam: {
        op: 'Forms_setSpam',
        about: 'Mark a submission spam or not (true|false)',
        args: ['formId', 'submissionId', 'spam'],
      },
      'submissions delete': {
        op: 'Forms_deleteSubmission',
        about: 'Delete a submission',
        args: ['formId', 'submissionId'],
        destructive: true,
      },
    },
  },
];
