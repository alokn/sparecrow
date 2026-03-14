# Vision: Distributed LLM Capacity for the Common Good

## The Wasted Cycle Problem

Every month, thousands of Claude Code subscribers leave capacity on the table. Subscriptions grant a fixed quota per billing period — and when the clock resets, unused capacity doesn't roll over. It simply vanishes. Multiply that by every developer, every team, every organization with a Pro or Team plan, and you're looking at an enormous pool of intelligent computation that evaporates every single month.

This is the same problem that [SETI@Home](https://setiathome.berkeley.edu/) identified with CPUs in 1999: millions of computers sitting idle while hard scientific problems went unsolved. Their answer was elegant — a screensaver that put spare cycles to work searching for extraterrestrial intelligence. Over its lifetime, SETI@Home harnessed the equivalent of millions of years of compute time from volunteers worldwide, becoming one of the largest distributed computing projects in history.

Sparecrow starts from the same premise, applied to a fundamentally different kind of resource. **What if we could do for LLM capacity what SETI@Home did for CPU cycles?**

## From Personal Automation to Collective Impact

Today, sparecrow monitors your Claude Code usage and dispatches your queued tasks — code reviews, security audits, test generation — when you have capacity to spare. It's a personal productivity tool. But the architecture it sits on — usage monitoring, priority queuing, template-based dispatch, container-isolated execution, audit logging — is the foundation for something much larger.

Imagine opting in to a **community queue**: a shared pool of tasks submitted by open-source maintainers, researchers, educators, and nonprofits who need the kind of deep code analysis that LLMs excel at but can't afford access to at scale.

When your personal queue is empty and your subscription still has room, sparecrow picks up a community task instead. Your idle capacity — capacity you've already paid for, capacity that would otherwise expire — goes to work on something that matters.

## What Donated Capacity Could Do

LLMs are uniquely suited to tasks that require broad comprehension of codebases, pattern recognition across thousands of lines, and natural-language synthesis of findings. The kind of work that's labour-intensive for humans but where AI assistance can dramatically accelerate outcomes:

**Open-Source Security**
Critical open-source infrastructure — the libraries that underpin hospitals, banks, and governments — is chronically under-audited. A distributed fleet of donated LLM capacity could run continuous security reviews across the open-source ecosystem, surfacing vulnerabilities before they become CVEs.

**Accessibility Audits**
Nonprofit websites, government portals, educational platforms — many lack the resources for thorough accessibility review. Donated capacity could systematically audit codebases against WCAG standards and generate actionable remediation plans.

**Research Code Quality**
Academic research increasingly depends on software, but research code is notoriously fragile — written under deadline pressure, rarely tested, seldom reviewed. Donated capacity could provide automated code review and test generation for research codebases in public health, climate science, genomics, and education.

**Documentation for Underfunded Projects**
Thousands of valuable open-source tools lack adequate documentation because maintainers — often volunteers — don't have time. LLM capacity can generate, review, and improve documentation at scale.

**Bug Hunting in Public Interest Software**
Software used in elections, emergency response, public transit, and social services rarely gets the same scrutiny as commercial products. Systematic bug hunting across these codebases could prevent failures where they matter most.

## The Distributed Model

The architecture mirrors the proven pattern of volunteer computing — but adapted for the economics of subscription-based AI:

```
┌──────────────────────────────────────────────────────┐
│                   Community Hub                       │
│                                                       │
│  ┌─────────────┐  ┌──────────┐  ┌─────────────────┐ │
│  │ Task Intake  │  │ Priority │  │ Result          │ │
│  │ (nonprofits, │→ │ Queue &  │→ │ Aggregation &   │ │
│  │  researchers,│  │ Matching │  │ Reporting        │ │
│  │  OSS maintrs)│  └──────────┘  └─────────────────┘ │
│  └─────────────┘        ↕                             │
└──────────────────────────────────────────────────────┘
                          ↕
        ┌─────────────────┼─────────────────┐
        ↓                 ↓                 ↓
  ┌───────────┐    ┌───────────┐    ┌───────────┐
  │ Volunteer │    │ Volunteer │    │ Volunteer │
  │ Node A    │    │ Node B    │    │ Node C    │
  │           │    │           │    │           │
  │ sparecrow │    │ sparecrow │    │ sparecrow │
  │ daemon    │    │ daemon    │    │ daemon    │
  │           │    │           │    │           │
  │ Personal  │    │ Personal  │    │ Personal  │
  │ queue     │    │ queue     │    │ queue     │
  │ first,    │    │ first,    │    │ first,    │
  │ community │    │ community │    │ community │
  │ queue     │    │ queue     │    │ queue     │
  │ second    │    │ second    │    │ second    │
  └───────────┘    └───────────┘    └───────────┘
```

**Key principles:**

1. **Your work comes first.** Community tasks only run when your personal queue is empty and you have surplus capacity. You never sacrifice your own productivity.

2. **Opt-in, always.** Donation is voluntary. You choose how much capacity to share, which categories of work you support, and when to pause.

3. **Sandboxed execution.** Community tasks run in containers with no access to your files, credentials, or local environment. Sparecrow's container execution engine already provides this isolation.

4. **Transparent attribution.** Every donated cycle is logged. Contributors can see exactly what their capacity accomplished — which projects were helped, what was found, how findings were used.

5. **Verifiable results.** Task outputs are reviewed before reaching requestors. Multiple volunteers can independently work the same task for consensus, similar to how BOINC projects validate results from multiple nodes.

## Why This Could Work Now

Several conditions have converged to make this feasible in a way it wasn't even a year ago:

- **Subscription models create predictable surplus.** Unlike pay-per-token APIs, subscriptions mean capacity exists whether you use it or not. The marginal cost of donating idle capacity is zero to the subscriber.

- **LLMs are general-purpose enough.** SETI@Home needed custom signal-processing code. LLMs can tackle an enormous range of code analysis tasks with nothing more than a well-written prompt template. The sparecrow template system already abstracts this.

- **Container isolation is mature.** Running untrusted workloads safely on volunteer machines was once a hard problem. Docker and Podman rootless mode make it routine. Sparecrow already supports both.

- **The need is real and growing.** Open-source maintainer burnout is well-documented. Research software quality is a recognised crisis. Nonprofits are being asked to do more with less. Meanwhile, AI capabilities that could help are locked behind subscription paywalls.

## What Would Need to Be Built

Sparecrow already provides the local execution engine. The path from personal tool to distributed platform requires:

| Component | Purpose | Status |
|-----------|---------|--------|
| Community hub API | Task intake, matching, result collection | Not started |
| Volunteer opt-in protocol | Capacity pledging, preference management | Not started |
| Task verification | Multi-node consensus, output validation | Not started |
| Requestor portal | Nonprofits/researchers submit and track tasks | Not started |
| Trust & reputation | Volunteer reliability scoring, requestor vetting | Not started |
| Privacy guarantees | Ensure no sensitive data leaks between parties | Partially addressed (container isolation) |
| Impact dashboard | Show contributors what their capacity accomplished | Not started |

## The Bigger Picture

SETI@Home proved that people will donate resources they're not using to causes they believe in — and that small individual contributions, aggregated at scale, can tackle problems no single institution could afford to solve alone.

The LLM equivalent of that spare CPU cycle is the subscription capacity that expires at the end of each billing period. It's already paid for. It's going to waste. And the problems it could address — insecure infrastructure, inaccessible services, unreliable research software — affect everyone.

Sparecrow is the screensaver. The question is what we point it at.

---

*This document describes a long-term vision for the sparecrow project. The current release is a personal CLI tool for automating Claude Code tasks. Community features described here are aspirational and not yet implemented.*
