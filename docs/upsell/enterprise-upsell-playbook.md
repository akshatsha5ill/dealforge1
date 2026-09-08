# Enterprise Upsell Playbook (Phase 4B)

Target: small sales teams (2–10 people) already on the Pro tier.
Goal: convert them to Enterprise ($79/mo/seat, or $59/mo/seat for teams of 5+).

## Positioning

**The one-liner**: "Your team is using DealForge individually. Enterprise gives you a shared pipeline and team analytics."

**Why it works**: Pro users are already paying and already experiencing the value of their own pipeline. The only missing thing is seeing the *whole team's* pipeline and aggregated insights — a natural step, not a new product.

**Value props (pick 2–3 per email, never all)**:
- Shared pipeline: every rep sees the same deals, stages, and owner
- Team analytics: aggregate meeting stats across the team
- Admin controls: manage members and billing in one place
- Priority support: a real human, fast
- Custom pipeline stages: match your exact sales process
- Team discount: $59/mo per seat (vs $79) for teams of 5+

## Trigger Events

| Trigger | Email |
|---------|-------|
| Pro user, 3+ active team members detected (shared account or multiple accounts same domain) | Email 1: Pro → Enterprise |
| Pro user clicked "Enterprise" or browsed billing page | Email 1 (day 0) |
| No reply after 5 days | Email 2: The team discount |
| No reply after 10 more days | Email 3: The proof |
| User's account shows 5+ distinct reps (via API sync data or email outreach volume) | Skip to Email 2 (qualified for discount) |

## Email 1 — Pro → Enterprise (Day 0)

**Subject**: Your team deserves a shared pipeline

Hey {first_name},

You've been using DealForge to track your own meetings and deals. But right now, every rep on your team is running their own private pipeline.

Enterprise changes that:

- **Shared pipeline** — every rep sees the same deals, stages, and owners
- **Team analytics** — see aggregate meeting stats across the whole team in one place
- **Admin controls** — manage members and billing in one dashboard

Your team is already using DealForge. It costs nothing extra to get them synced up.

[Check out Enterprise →]

— The DealForge team

## Email 2 — The Team Discount (Day 5)

**Subject**: $59/seat for teams of 5+ (final offer for the quarter)

Hey {first_name},

If your team has 5+ reps, Enterprise just got cheaper: **$59/mo per seat** instead of $79 — a 25% discount.

At 5 seats that's $295/mo for the whole team, with a shared pipeline, team analytics, and priority support.

[Claim the team discount →]

This pricing is locked for the current quarter, so if you're thinking about it, now's the time.

— The DealForge team

## Email 3 — The Proof (Day 15)

**Subject**: What happens when a team shares its pipeline

Hey {first_name},

Teams that switch to Enterprise typically see the same pattern:

- Deals stop slipping between reps — everyone can see the real stage
- Meetings get better — reps learn from each other's win/loss calls via team analytics
- Managers stop asking "where is this deal?" — the pipeline answers it

One Pro customer put it simply: *"It was like watching the lights come on for the whole team at once."* _(Illustrative sample copy — replace with a real, permissioned testimonial before publishing.)_

Ready to see it for your team? [Start your Enterprise trial →]

— The DealForge team

## Sales Notes

- **Trial**: Enterprise is $79/mo — offer a 14-day free trial for the team to see the shared pipeline before paying. This removes the biggest purchase blocker (unknown fit).
- **Seat math**: always anchor on per-seat price, not the total. $59/seat/month beats "$295/mo" emotionally.
- **Renewal hook**: the team discount is a lock-in — once a team shares a pipeline, churn becomes near-zero because switching costs multiply by team size.
- **Measurement**: track Enterprise page views, trial starts, and MRR from teams. Goal: 25+ paid users by month 9 (internal plan projection — not a public commitment).

## Pricing Card Copy (BillingPage)

Already implemented in the billing page:

- Pro: $29/mo — includes the new read-only API access (Phase 4C)
- Enterprise: $79/mo/seat — "Team discount: $59/seat/mo for teams of 5+" note on the card
