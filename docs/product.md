# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Sales representatives running discovery and closing calls.

## Product Purpose
To streamline the sales workflow by automating CRM entry and lead follow-up directly from Zoom transcripts, saving reps time on administrative tasks.

## Positioning
Acts as a seamless assistant during and after Zoom meetings, bridging live call data (transcripts, notes) with automated downstream actions (drip campaigns, lead updates).

## Operating Context
Used during live Zoom meetings via a side-panel for real-time transcription and suggestions, and accessed via a web dashboard for pipeline management, settings, and analytics. It stores data locally and relies on weekly file-system backups.

## Capabilities and Constraints
- Real-time Zoom transcription, suggestions, and notes.
- Lead automation and automated drip campaigns running via workers.
- Local-first data storage (Dexie) with explicit user permission flows for directory backups.
- Full creative freedom for the visual design; no legacy brand assets are binding.

## Brand Commitments
The visual language must strictly adhere to the `DESIGN.md` brief: "The Industrial Journal," featuring Fraunces and Newsreader serif typography, warm parchment backgrounds, oxblood accents, structural 1px rules, and a tactile paper-grain aesthetic.

## Evidence on Hand
Codebase evidence indicates a functional dashboard and Zoom panel structure. The visual design is governed entirely by the updated `DESIGN.md`.

## Product Principles
- **Invisible Administration**: The system should do the heavy lifting of CRM entry so the rep doesn't have to.
- **Context-Aware Assistance**: Provide suggestions and notes precisely when they matter during a call.
- **Data Ownership**: Leverage local-first storage and explicit backup permissions to build user trust.
