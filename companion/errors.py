"""Job error codes for the processor (architecture §6.1, §6.10 CPB item 1).

The processor reports a failure as one JSON line, ``{"error": detail, "code": code}``.
``detail`` is the raw text (the client shows it behind Details); ``code`` picks the
sentence and the action in the client (src/app/error-copy.js). No user copy lives
here. Rules: docs/ux2/maps/companion-desktop.md §10.2.
"""
from __future__ import annotations

import re

#: Every code the processor can report (a subset of convex/lib/errors.ts JOB_ERROR_CODES;
#: the companion adds storage_full, account_paused and sync_failed on its side).
CODES = (
    'bot_check',
    'unavailable',
    'not_found',
    'unreadable',
    'source_missing',
    'disk_full',
    'separation_failed',
    'beats_unavailable',
    'unknown',
)

# YouTube's automated-traffic refusal. "Sign in to confirm your age" is an age
# gate, not a bot check: waiting will not help, so it is `unavailable`
# (the same rule as companion/lookup.mjs BOT_CHECK).
BOT_CHECK = re.compile(r"not a bot|sign in to confirm(?! your age)", re.I)

# The same list as companion/lookup.mjs UNAVAILABLE: the video exists but cannot be had.
UNAVAILABLE = re.compile(
    r"private video|video is private|video unavailable|is not available|available in your (?:country|region)"
    r"|geo.?restrict|has been removed|members-only|account .* terminated|confirm your age|age.?restricted"
    r"|premieres in|live event will begin|copyright (?:claim|grounds)",
    re.I,
)

# Nothing at that address, or a search with no usable result.
NOT_FOUND = re.compile(
    r"unsupported url|http error 404|\b404\b.*not found|does not exist|no such (?:track|video|user)"
    r"|no video results|returned no (?:results|entries)",
    re.I,
)

# The processor's own raise sites that mean "nothing to download" (pipeline.py).
NOTHING_DOWNLOADED = re.compile(r"No audio could be downloaded|Could not resolve this Spotify link", re.I)

DISK_FULL = re.compile(
    r"No space left on device|ENOSPC|Errno 28|There is not enough space on the disk|disk quota exceeded", re.I
)

SOURCE_MISSING = re.compile(
    r"Original file is not on this computer|Original file unavailable locally|Legacy files missing", re.I
)

# A Python module the detector needs is not installed (BeatNet, madmom, librosa, …).
MISSING_MODULE = re.compile(r"No module named", re.I)

# ffmpeg could not read an uploaded file as audio.
UNREADABLE = re.compile(
    r"Invalid data found when processing input|Error opening input|could not find codec parameters"
    r"|does not contain any stream|moov atom not found|Invalid argument",
    re.I,
)

# The first line of pipeline.run's failure text: "<tool> exited with code N".
TOOL_FAILURE = re.compile(r"^\s*(?P<tool>[\w.-]+) exited with code (?P<status>-?\d+)", re.M)


def failed_tool(detail: str) -> str | None:
    """The tool named by pipeline.run's failure text ("yt-dlp", "ffmpeg", "separator"), else None."""
    m = TOOL_FAILURE.search(detail or '')
    return m.group('tool') if m else None


def classify(detail: str, *, stage: str | None = None, source_type: str | None = None) -> str:
    """The job error code for a failure's raw text.

    ``stage`` is the last stage the job reported (``download``, ``separate``,
    ``finalize``, ``detect``); ``source_type`` is the job's source type
    (``upload``, ``url``, ``search``, ``spotify``), or None for detection and imports.
    """
    text = detail or ''
    tool = failed_tool(text)
    # Local, whatever was running: no tool can finish without space.
    if DISK_FULL.search(text):
        return 'disk_full'
    if SOURCE_MISSING.search(text):
        return 'source_missing'
    if BOT_CHECK.search(text):
        return 'bot_check'
    if stage == 'detect' and MISSING_MODULE.search(text):
        return 'beats_unavailable'
    # Any failure while separating (separator exit, OOM, a kill) is the split failing.
    if stage == 'separate' or tool == 'separator':
        return 'separation_failed'
    remote = source_type not in (None, 'upload')
    if tool == 'yt-dlp' or (remote and stage in (None, 'download')):
        if UNAVAILABLE.search(text):
            return 'unavailable'
        if NOT_FOUND.search(text):
            return 'not_found'
    if NOTHING_DOWNLOADED.search(text):
        return 'not_found'
    if source_type == 'upload' and stage in (None, 'download') and (tool == 'ffmpeg' or UNREADABLE.search(text)):
        return 'unreadable'
    return 'unknown'


def describe(error: BaseException) -> str:
    """The raw text for a failure: the message, with the exception type when it is not self-describing."""
    message = str(error).strip()
    if isinstance(error, RuntimeError) or type(error).__name__ == 'BotChecked':
        return message or type(error).__name__
    return f'{type(error).__name__}: {message}' if message else type(error).__name__
