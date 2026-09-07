---
name: DealForge
description: An industrial, editorial operating system
colors:
  primary: "#8a2317"
  secondary: "#a87714"
  tertiary: "#5d7440"
  neutral-bg: "#f3ebd9"
  neutral-bg-2: "#faf3e2"
  neutral-bg-3: "#e9dec3"
  neutral-code: "#efe5cc"
  neutral-ink: "#1c1813"
  neutral-ink-2: "#4a4338"
  neutral-ink-3: "#847a64"
  neutral-rule: "#c9be9f"
  neutral-rule-soft: "#ddd1b3"
typography:
  display:
    fontFamily: "\"Fraunces\", Georgia, serif"
    fontWeight: 700
    letterSpacing: "-0.028em"
  headline:
    fontFamily: "\"Fraunces\", Georgia, serif"
    fontWeight: 500
    letterSpacing: "-0.015em"
  body:
    fontFamily: "\"Newsreader\", Georgia, serif"
    fontWeight: 400
    lineHeight: 1.62
  label:
    fontFamily: "\"JetBrains Mono\", \"SF Mono\", Menlo, monospace"
    fontWeight: 400
rounded:
  none: "0px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "24px"
  xl: "36px"
components:
  button-primary:
    backgroundColor: "{colors.neutral-ink}"
    textColor: "{colors.neutral-bg}"
    padding: "14px 22px"
    rounded: "{rounded.none}"
  button-ghost:
    textColor: "{colors.neutral-ink-2}"
    padding: "14px 8px"
    rounded: "{rounded.none}"
---

# Design System: DealForge

## Overview

**Creative North Star: "The Industrial Journal"**

This system is built around the aesthetic of the working programmer, classic print, and raw materials. It feels rigorous but tactile, like reading a beautifully typeset physical textbook. It steps away from conventional "tech" or "glassmorphic" SaaS patterns in favor of heavy ink, visible rules, paper-like backgrounds, and structural layouts. 

**Key Characteristics:**
- **Tactile and grounded:** Backgrounds use a paper grain multiply blend to simulate physical texture.
- **Editorial typographic scale:** Extremely expressive display serifs paired with highly readable text serifs and utilitarian monospaced accents.
- **Structural dividing lines:** Hierarchy and layout are defined by literal 1px rules rather than whitespace and drop shadows.

## Colors

The palette is warm, grounded in paper and ink, with stark, highly saturated accents reserved for critical signals.

### Primary
- **Oxblood** (#8a2317): Used for links, highlights, interactive states, and celebration/success markers. A deep, rich red that commands attention without screaming.

### Secondary
- **Antique Gold** (#a87714): Used for warnings, syntax highlighting accents, and subtle status markers.

### Tertiary
- **Sage Green** (#5d7440): Used for completion, success, and positive state markers.

### Neutral
- **Paper** (#f3ebd9): The core page background.
- **Soft Paper** (#faf3e2): Used for panels and secondary backgrounds.
- **Deep Ink** (#1c1813): The primary text color and primary button background.
- **Rule** (#c9be9f): The structural 1px border color used to build the grid.

### Named Rules
**The Single-Pigment Rule.** Only use the primary Oxblood accent for active or hovered interactive states. UI elements rest in ink and paper, lighting up only when focused or hovered.

## Typography

**Display Font:** "Fraunces", Georgia, serif
**Body Font:** "Newsreader", Georgia, serif
**Label/Mono Font:** "JetBrains Mono", "SF Mono", Menlo, monospace

**Character:** A highly literary and rigorous pairing. Fraunces brings an organic, almost engraved beauty to large headings, while Newsreader ensures long-form data reading is comfortable. JetBrains Mono provides the unvarnished utility required for labels and code blocks.

### Hierarchy
- **Display** (700, clamp(46px, 7.4vw, 92px)): Hero section titles. Often pairs normal text with an *italicized* sub-phrase.
- **Headline** (500, clamp(28px, 3.4vw, 40px)): Section and page headers.
- **Title** (500, 22px): Library item titles and card headers.
- **Body** (400, 17px, 1.62): The main reading text and data readout.
- **Label** (500, 11px, 0.12em, UPPERCASE): Eyebrows, small-caps metadata, and tags.

### Named Rules
**The Editorial Contrast Rule.** Hero typography always includes a high-contrast pairing within the same heading—usually bold Roman text followed by italicized text in the primary Oxblood color.

## Layout

A strictly structural, column-based grid. Max width is capped at 1280px. Columns, sidebars, and sections are rigorously divided by 1px solid lines (`#c9be9f`), creating a literal table or ledger feel. Asymmetrical 7:5 and 2:1 column splits are used for hero sections and reading areas.

## Elevation & Depth

Completely flat and border-driven, like printed ruled paper. Shadows are reserved strictly for floating/pop-up elements.

### Shadow Vocabulary
- **Celebration Modal** (`box-shadow: 0 8px 32px rgba(168, 119, 20, 0.2)`): The single exception to the flat rule, used for popups that must float completely off the page.

### Named Rules
**The Ledger Rule.** Sections sit side-by-side, divided by borders, never layered via z-index or drop shadows.

## Shapes

Sharp, hard, unyielding 0px corners. Utilitarian and blocky. No border radii are used anywhere in the system, enforcing the print and stamped-ink metaphor.

## Components

Buttons and inputs are utilitarian, sharp, and high-contrast, mimicking stamped ink.

### Buttons
- **Shape:** 0px radius.
- **Primary:** Deep Ink background (`#1c1813`) with Paper text (`#f3ebd9`). Padding is 14px 22px.
- **Hover / Focus:** Inverts or shifts to Oxblood (`#8a2317`) background.
- **Ghost:** Minimal, border-bottom only, turning Oxblood on hover.

### Inputs / Fields
- **Style:** 0px radius, Paper Code background (`#efe5cc`), Deep Ink text.
- **Focus:** No shadow glow; instead, the border color sharpens to Oxblood.

### Navigation
- **Style:** Small-caps, monospaced metadata, separated by 1px rules, sitting within a sticky masthead bordered at the bottom.

## Do's and Don'ts

### Do:
- **Do** rely on 1px solid borders (`var(--rule)`) to separate content panels.
- **Do** use `var(--ink)` for strong utilitarian actions.
- **Do** apply the paper grain SVG filter to the `body` element to give the UI tactile depth.

### Don't:
- **Don't** use `border-radius`. Ever.
- **Don't** use drop shadows for hovering cards. Use a subtle background shift (`var(--bg-2)`) instead.
- **Don't** use gradients. Color must be solid, like ink on paper.
