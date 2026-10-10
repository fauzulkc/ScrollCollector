<!--
DRAFT for the owner's read (release runbook, Part A row 4). Written by the 🧷 Browser-extension engineer
2026-10-11 from the code at version 0.10.0. The owner approves the words, fills the contact line, and hosts
this page at a public URL (Part B step 2). Every claim below names its source in docs/STORE-LISTING.md
("Data use"); a change to what leaves the device changes this page in the same commit.
-->

# ScrollCollector privacy policy

_Last updated: [date of publishing]_

ScrollCollector is a Chrome extension that saves posts you scroll past on sites you choose and sorts them
against your own prompts. This page says what it reads, where that is kept, and when anything leaves your
computer.

## What ScrollCollector reads
On the sites you have turned on (by default Facebook, LinkedIn, X, Instagram, YouTube, Medium, GitHub and
Hacker News, plus any site you add), it reads the posts on the page: their text, link, the site, the author
name shown on the post, and the address of the page you saw them on. It does not read any other site, your
messages, your passwords or your form entries.

## Where it is kept
Everything stays in your browser, on your computer: your saved posts, your prompts and tags, your settings, and
a cache the extension uses to compare posts. The deciding is done on your computer by a small model that ships
inside the extension, and by Chrome's built-in AI (Gemini Nano) where your browser provides it.

We (the developer) do not run a server for ScrollCollector and receive none of your data. There are no
analytics, no tracking and no advertising. The "Telemetry Overview" in the side panel is a count shown to you
only.

## When something leaves your computer
Only if you choose to. Two optional cloud providers can give a second opinion on posts the on-device model is
unsure about: **TypeSafe** (Jev) and **OpenAI**. Both are off until you switch one on and enter your own API key.
When one is on:
- only posts the on-device model was unsure about are sent, never your whole collection;
- what is sent is the post's text and site, with your prompt and tags; the author name is removed first;
- it goes to the one provider you picked, under your own account with that provider, and that provider's own
  privacy policy applies to it;
- your API key is stored in your browser and sent only to that provider.

Switch the provider off, or remove the key, and nothing is sent again.

## Sharing
We do not sell, rent or share your data with anyone, and we do not use it for anything except showing you
your collection.

## Your control
- Turn collection on or off per site in the side panel.
- Export your collection (HTML, JSON or CSV) from the side panel's Export tab.
- Delete it with "Clear stream" in the side panel, or remove the extension, which deletes everything it stored.

## Changes and contact
If this policy changes, the new version is posted at this address with a new date. Questions:
[contact address the owner chooses].
