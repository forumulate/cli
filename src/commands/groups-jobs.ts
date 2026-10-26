import type { GroupDef } from './resource';

/**
 * Background work, and the commands that start it (FMU-D03): the one job
 * model (`jobs`), and the long-running operations a CI pipeline runs and then
 * waits on — backups, organization imports and the provisioning manifest.
 * Every starter takes `--wait [--timeout <s>]` and exits 0 completed, 1
 * failed, 124 timed out.
 */
export const JOB_GROUPS: GroupDef[] = [
  {
    name: 'jobs',
    noun: 'job',
    about: 'background jobs in one shape: list, get, and wait for one to finish',
    verbs: {
      list: {
        op: 'Jobs_list',
        about: 'Recent jobs, newest first (--kind org.import|forum.import|org.backup|content.sync|status.import|manifest.apply|member.relink)',
        pick: 'jobs',
        columns: ['id', 'kind', 'state', 'createdAt', 'finishedAt'],
      },
      get: { op: 'Jobs_get', about: 'One job: state, progress, result or error', args: ['jobId'] },
      wait: {
        op: 'Jobs_get',
        about: 'Block until a job is final (--timeout 600): exit 0 completed, 1 failed, 124 timeout',
        args: ['jobId'],
        waits: true,
      },
    },
    defaultVerb: 'list',
  },
  {
    name: 'backups',
    noun: 'backup',
    about: 'organization backups: take one, list them, download or restore one',
    verbs: {
      list: { op: 'OrgBackup_list', about: 'Recent backups', columns: ['id', 'state', 'createdAt', 'finishedAt'] },
      create: { op: 'OrgBackup_create', about: 'Take a backup now [--wait]', job: true },
      download: {
        op: 'OrgBackup_download',
        about: 'Download one (--out backup.tar.gz)',
        args: ['backupId'],
        download: 'backup.tar.gz',
      },
      restore: {
        op: 'OrgBackup_restore',
        about: 'Restore one into this organization as an import [--wait]',
        args: ['backupId'],
        job: true,
        destructive: true,
      },
      delete: { op: 'OrgBackup_remove', about: 'Delete a backup file', args: ['backupId'], destructive: true },
    },
    defaultVerb: 'list',
  },
  {
    name: 'imports',
    noun: 'import',
    about: 'queued organization imports (the `POST /orgs/{org}/import` document, run by the worker)',
    verbs: {
      list: { op: 'OrgImportJob_list', about: 'Recent imports' },
      create: { op: 'OrgImportJob_enqueue', about: 'Queue an import (--data @org-import.json) [--wait]', job: true },
      get: { op: 'OrgImportJob_get', about: 'One import as a job', args: ['jobId'] },
    },
    defaultVerb: 'list',
  },
  {
    name: 'manifest',
    noun: 'manifest',
    about: 'the declarative site manifest: plan, apply, export (adopt) and its runs',
    verbs: {
      plan: { op: 'Manifest_apply', about: 'Plan a manifest, writing nothing (--data @manifest.json)' },
      apply: {
        op: 'Manifest_apply',
        about: 'Apply a manifest (--data @manifest.json) [--wait]; exit 1 when a unit failed',
        query: { apply: 'true' },
        job: true,
      },
      export: {
        op: 'Manifest_export',
        about: 'The organization as a version-2 manifest with ids (adopt)',
        query: { export: 'true' },
      },
      run: { op: 'Manifest_runStatus', about: 'One apply run, as a job', args: ['runId'] },
    },
  },
];
