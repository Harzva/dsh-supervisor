#!/usr/bin/env python3
"""Read only a named submission ZIP; emit redacted, bounded scan evidence."""
import argparse
import datetime
import hashlib
import json
import re
import stat
import zipfile
from pathlib import Path, PurePosixPath

parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path)
args = parser.parse_args()
if args.archive.is_symlink() or not args.archive.is_file():
    raise SystemExit('ARCHIVE_NOT_PLAIN_FILE')
if args.archive.stat().st_size > 100 * 1024 * 1024:
    raise SystemExit('COMPRESSED_ARCHIVE_SIZE_LIMIT')
archive_bytes = args.archive.read_bytes()
patterns = {
    'openai_key': rb'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b',
    'github_token': rb'\b(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{20,}\b',
    'slack_token': rb'\bxox[abprs]-[A-Za-z0-9-]{20,}\b',
    'google_api_key': rb'\bAIza[A-Za-z0-9_-]{30,}\b',
    'private_key_block': rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'jwt_literal': rb'\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b',
}
findings = []
private_paths = []
unsafe_entries = []
total_bytes = 0
with zipfile.ZipFile(args.archive) as archive:
    entries = archive.infolist()
    if len(entries) > 1000:
        raise SystemExit('ARCHIVE_ENTRY_LIMIT')
    for entry in entries:
        name = entry.filename
        pure = PurePosixPath(name)
        if pure.is_absolute() or '..' in pure.parts or '\\' in name or stat.S_ISLNK(entry.external_attr >> 16):
            unsafe_entries.append(name)
            continue
        if entry.is_dir():
            continue
        if entry.file_size > 10 * 1024 * 1024 or total_bytes + entry.file_size > 100 * 1024 * 1024:
            raise SystemExit('ARCHIVE_SIZE_LIMIT')
        total_bytes += entry.file_size
        if re.search(r'(^|/)(?:\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|execution\.v1\.json|state\.v1\.json|settings\.v1\.json|control\.v1\.json|bindings\.v1\.json|handoffs)(/|$)|\.(?:pem|key|log)$', name, re.I):
            private_paths.append(name)
        data = archive.read(entry)
        for label, pattern in patterns.items():
            for match in re.finditer(pattern, data):
                findings.append({'file': name, 'pattern': label, 'line': data[:match.start()].count(b'\n') + 1, 'matchSha256': hashlib.sha256(match.group()).hexdigest()})
                if len(findings) > 100:
                    raise SystemExit('FINDING_LIMIT')
    manifests = {}
    for name in ('plugin.json', '.codex-plugin/plugin.json'):
        value = json.loads(archive.read(name))
        manifests[name] = {'name': value.get('name'), 'version': value.get('version')}
report = {
    'ok': not findings and not private_paths and not unsafe_entries,
    'date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'archive': args.archive.name,
    'sha256': hashlib.sha256(archive_bytes).hexdigest(),
    'entryCount': len(entries), 'uncompressedBytes': total_bytes,
    'manifests': manifests, 'highConfidencePatternFindings': findings,
    'privateStateOrCredentialPaths': private_paths, 'unsafeArchiveEntries': unsafe_entries,
    'patternsChecked': list(patterns), 'rawMatchedContentEmitted': False,
    'scope': 'Named ZIP only; no HOME, session directories or credentials were opened.',
    'limitations': 'Heuristic scan, not a proof that all secrets or personal data are absent. Manually inspect product metadata, fixtures and final evidence exports; rerun against every final rebuilt ZIP.'
}
print(json.dumps(report, indent=2))
raise SystemExit(0 if report['ok'] else 1)
