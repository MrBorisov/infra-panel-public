# Roadmap

What could be done next.

## Alerts

The first item affects both the Telegram bot (`bots/telegram-bot.py`) and the Discord poller (`bots/discord-poller.py`).

- **Double sending.** If `mark-sent` does not reach the panel, the bot sends the same messages again on the next round. Options: retry `mark-sent`, or remember sent ids on the bot side.
- **Due-date reminders in the users' time zone.** The day boundary and the "repeats from 9:00" window use server time, which is often UTC: thresholds (7/3/1 days before and on the day, plus 30 days for domains) arrive at night local time. Option: a time zone for the panel only (`TZ` in a unit drop-in, leaving the server's system time alone) and the 9:00 window for all reminders, not just repeats.

## Infrastructure

- Import from CSV/Excel (only domains can be pasted as a list now).
- Passwork API integration: search entries right from the panel.
- VM status and balance via hosting provider APIs (Hetzner, Timeweb, Selectel…).
- Metrics over SSH: disk, memory, load.
- Check that a domain's DNS record points to the right server.
- English UI (the interface and alert texts are in Russian now).
