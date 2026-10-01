# Changelog

## 0.2.0 - 2026-10-01

- Dedicated question page with author, responsible reviewer, current answer, voting and team comments.
- Independent reviewer editors, browser draft recovery and unsaved-change navigation protection.
- Immutable named revisions; saving never replaces another reviewer's work or resets votes.
- Responsible reviewer selects a revision during discussion; previous votes are archived and a new 24-hour round starts.
- Automatic delivery of the current answer after 24 hours with a positive majority or zero votes in new rounds. Nonzero ties and negative majorities remain open. Existing rounds retain their original policy.
- Requesters receive only the final answer and do not access discussions or revisions.
- Concise, complete model draft combining internal and web evidence; citations and bibliographies remain outside the answer text.
- Neutral terminology across roles, queues, titles and synthetic tests. No bundled provider connection or knowledge corpus.
- Source and production-frontend release packaging with private configuration, runtime stores and dependencies excluded.
- Updated English and Russian documentation and adapter contracts.

Validation: 50 API tests, 13 retrieval-service tests, frontend production build. Containers and external integrations were not started.
