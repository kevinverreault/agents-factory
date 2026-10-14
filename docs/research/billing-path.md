# Which Claude billing path fits the factory?

Research for issue #2 (map: #1 "Agent factory v1"). All sources were read on **2026-10-14**. Prices are in USD and were checked against the live pages on that date, not taken from memory. Anthropic says plans and prices can change "at Anthropic's discretion", so check again before committing money.

## Answer in brief

- **Plans.** Pro costs $20/month ($17/month billed annually). Max 5x costs $100/month and Max 20x costs $200/month. Every paid plan has a rolling **5-hour session limit** plus a **weekly limit**. Chat, Claude Code, `claude -p` and the Agent SDK all draw from **one shared pool**. Anthropic does not publish the limits in tokens or messages, only as multiples: Pro is at least 5x Free, and Max is 5x or 20x Pro per 5-hour session.
- **Headless runs on a subscription.** Running headless with a subscription login is **currently allowed** for the operator's own use. A help-center article updated on 2026-10-07 says "You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits". A change to Agent SDK usage announced earlier was "paused" on 2026-06-15. Some wording still conflicts, though: the Consumer Terms ban on automated access, the "ordinary, individual usage" language, and the statement that the Agent SDK is governed by the Commercial Terms. Treat this as **policy risk**, not as a settled right.
- **API (pay per token)** for the current tiers, per million tokens (input / output): Opus 5.5 costs $4 / $20, Sonnet 5.5 costs $2 / $10, and Haiku 5.5 costs $0.10 / $0.50 for prompts up to 100K tokens. Cache reads cost 0.05x the input price on Opus 5.5 and Sonnet 5.5. A typical 60-request agentic coding session comes to roughly **$2.35 on Sonnet 5.5 and $4.70 on Opus 5.5**.
- **Max includes API credits.** Max comes with **$100 (5x) or $200 (20x) per month of API credits**. They work with the Agent SDK and with `claude -p` run against an API key, but not with Claude Code under subscription login. That gives Max a second, dollar-denominated pool.
- **Reading the usage window.** Several programmatic ways exist: the status-line JSON `rate_limits.five_hour` / `seven_day`, the Agent SDK's `rate_limit_event`, and an experimental `usage_report` returned when `/usage` is sent through the SDK. **No standalone public REST endpoint** for subscription usage was found.

**Recommendation.** Run the factory on a **subscription login through the unmodified `claude` binary or the Agent SDK**. Plan to move from Pro to **Max 5x** once runs go parallel, and to Max 20x only if the weekly cap becomes the binding limit. Treat Max's monthly API credits as an **overflow pool** behind an API-key executor that has its own spend limit. Put the credential choice behind the routing seam so a policy change only means switching which credential the executor uses. Details are in the last section.

## 1. Subscription plans

| Plan | Price | Usage per 5-hour session | Models (pricing page table) | Claude Code |
|---|---|---|---|---|
| Free | $0 | baseline | Sonnet, Haiku (no Opus, no Fable) | No |
| Pro | $20/mo monthly, or $17/mo billed annually ($200 up front) | "at least 5x more usage per 5-hour session than Free" | Opus, Sonnet, Haiku; Fable only via usage credits | Yes |
| Max 5x | $100/mo (billed monthly only) | 5x Pro | Opus, Sonnet, Haiku; Fable capped at "50% of weekly limits" | Yes |
| Max 20x | $200/mo (billed monthly only) | 20x Pro | same as Max 5x | Yes |

Sources: [claude.com/pricing](https://claude.com/pricing) for Pro $20/$17, Max "From $100", and the model table. [What is the Max plan?](https://support.claude.com/en/articles/11049741-what-is-the-max-plan) gives "$100 per month" and "$200 per month", with the note "These prices are for web subscriptions only. Mobile pricing may vary". [What is the Pro plan?](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan) confirms "$20 per month (US)".

### How the windows work

- **The 5-hour session window is rolling.** The pricing FAQ says: "usage limits that reset on a rolling five-hour session window, and paid plans add weekly limits on top" ([pricing](https://claude.com/pricing)).
- **The weekly limit resets at a fixed time per account.** The weekly limit "applies across all models and resets at a fixed time assigned to your account", which is visible in Settings > Usage ([Pro plan article](https://support.claude.com/en/articles/8325606-what-is-the-pro-plan), [Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)). Max also has a **separate weekly limit for Fable**.
- **One shared pool.** The pricing FAQ says: "Your activity across Claude on web, desktop, mobile, and Claude Code all draws from the same pool." The support article says "all activity in both tools counts against the same limits", and IDE usage counts too. **This means the operator's interactive chat competes with factory runs.**
- **There is no fixed unit.** The pricing FAQ says usage "depends on the length and complexity of your conversations, the model you choose, and the features you use, so there's no fixed message count". The [usage limits article](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work) names the model and the effort level as factors. Anthropic also reserves the right to "limit your usage in other ways, such as weekly and monthly caps or model and feature usage, at our discretion".
- **Wrap-up allowance.** Near a cap, Claude Code may finish its current step ("Usage limit reached · wrapping up"). On Pro this applies at most once per weekly period. On Max it can apply each time a 5-hour limit is hit (support article above).
- **Usage credits (overage).** When enabled, these are billed "at standard API rates", are prepaid, and have an optional monthly spend limit. "Usage credits apply to both Claude conversations and Claude Code terminal usage" ([Manage usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)).
- **Cache TTL differs on a subscription.** On a subscription, the prompt-cache lifetime is **1 hour** within included usage, and it drops to 5 minutes once you draw on usage credits. With an API key the default is 5 minutes ([Claude Code costs](https://code.claude.com/docs/en/costs), section "Why usage climbs in a long session").
- **Default model.** On Pro, Max and the API, the `default` model in Claude Code is Opus 5.5 as of v2.1.280 ([model config](https://code.claude.com/docs/en/model-config)). Opus 4.6 with 1M context is included on Max but needs usage credits on Pro (same page).

### Monthly API credits on Max

| Plan | Monthly credit | Covers | Doesn't cover |
|---|---|---|---|
| Max 5x | $100 | Claude API, Managed Agents, **Claude Agent SDK**, Playground | Claude Code, extra usage in the apps |
| Max 20x | $200 | same | same |
| Pro | not eligible | | |

The credits expire at the end of each billing cycle with no rollover. You claim them by linking one Console organization, after 7 days on the plan. Linking moves that organization to at least the Start tier, whose monthly spend cap is $500 ([API credits for Max and Team plans](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers), [help-center version](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans), [rate limits](https://platform.claude.com/docs/en/api/rate-limits)). The help center is explicit about the split. The credits cover `claude -p` "when you run them yourself with an API key" from the linked organization. When signed in with the plan, `claude -p` and Agent SDK usage "still draw from your plan's usage limits". Runs started by the GitHub Action, an IDE extension or the desktop app count as Claude Code usage even with `-p`.

## 2. May a subscription login drive headless runs and the Agent SDK?

**The current answer is yes, for the operator's own use. The terms are not airtight, so record this as a policy risk.**

Statements that permit it:

- [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), update dated 2026-10-07: "You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits." The same article's 2026-06-15 update says "We've paused the previously-announced changes to Claude Agent SDK usage." It does not say what those changes were, and I could not find a primary source describing them.
- The [Max API credits FAQ](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans) says plan-signed-in `claude -p` and Agent SDK usage "still draw from your plan's usage limits".
- [Authentication](https://code.claude.com/docs/en/authentication): `claude setup-token` creates a **one-year** OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`). Its documented purpose is "CI pipelines, scripts, or other environments where interactive browser login isn't available". The token "authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan".
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance): the restriction applies to *developers offering* claude.ai login to others. It says "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users." It explicitly does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".

Statements that create ambiguity:

- [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (effective 2025-10-08), section 3: "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it", users may not "access the Services through automated or non-human means, whether through a bot, script, or otherwise." Pro and Max fall under these terms. The `setup-token` documentation and the help-center article above look like the "explicitly permit" exception, but the Terms themselves do not name them.
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) says OAuth is "designed to support ordinary use of Claude Code and other native Anthropic applications", and that "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." The same page says developers building with the Agent SDK "should use API key authentication", and that Anthropic "may [enforce] without prior notice".
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." The same page says the SDK is "governed by Anthropic's Commercial Terms of Service", while Pro and Max are covered by the Consumer Terms.

My reading: a single operator running their own factory on their own machine, signed in through Anthropic's flow to the unmodified binary, is the case the help center now describes as allowed. The factory must never handle the claude.ai credentials itself, and must never be offered to other users with subscription login. Heavy, round-the-clock parallel automation strains "ordinary, individual usage", and Anthropic has shown it may change this policy (the paused June change). The design should therefore keep an API-key fallback ready.

Practical constraints:

- `--bare` mode does **not** use the subscription login and needs `ANTHROPIC_API_KEY` ([headless](https://code.claude.com/docs/en/headless)).
- If `ANTHROPIC_API_KEY` is set, it **wins over** the subscription in `-p` mode, so it must be kept out of the environment of subscription runs ([authentication precedence](https://code.claude.com/docs/en/authentication)).
- On Windows the login is stored in `%USERPROFILE%\.claude\.credentials.json`. A `/login` credential expires, and unattended sessions "stop making progress" until the operator logs in again. Claude Code warns 3 days ahead (same page).

## 3. API per-token prices

The table below is from [platform.claude.com pricing](https://platform.claude.com/docs/en/about-claude/pricing). Prices are per million tokens.

| Model | Input | 5m cache write | 1h cache write | Cache hit | Output |
|---|---|---|---|---|---|
| Fable 5.1 | $10 | $12.50 | $20 | $0.25 | $50 |
| Opus 5.5 | $4 | $5 | $8 | $0.20 | $20 |
| Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 | $5 | $6.25 | $10 | $0.50 | $25 |
| Sonnet 5.5 | $2 | $2.50 | $4 | $0.10 | $10 |
| Sonnet 5 | $2 | $2.50 | $4 | $0.20 | $10 |
| Sonnet 4.6 / 4.5 | $3 | $3.75 | $6 | $0.30 | $15 |
| Haiku 5.5 (prompt ≤ 100K) | $0.10 | $0.125 | $0.20 | $0.01 | $0.50 |
| Haiku 5.5 (prompt > 100K) | $0.50 | $0.625 | $1 | $0.05 | $2.50 |
| Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |

Modifiers that apply on top:

- A 5-minute cache write costs 1.25x the input price and a 1-hour write costs 2x. A cache hit costs 0.1x, except on Opus 5.5 and Sonnet 5.5 (0.05x) and on Fable 5.1 (0.025x).
- The Batch API halves the price. It does not fit interactive agent runs.
- `inference_geo: "us"` multiplies prices by 1.1.
- Fast mode on Opus 5.5 costs $8 / $40.
- Opus and Sonnet 4.6 and later include the 1M context window at standard prices. Haiku 5.5 charges a higher price once a prompt goes over 100K tokens.
- Thinking tokens are billed as output. Thinking cannot be turned off on Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable ([costs](https://code.claude.com/docs/en/costs)).
- The Claude 4.7+ tokenizer produces "approximately 30% more tokens for the same text".

API rate limits are a separate concern from cost ([rate limits](https://platform.claude.com/docs/en/api/rate-limits)). The Start tier has a $500/month spend cap and allows 1,000 RPM, 2M input tokens per minute and 400K output tokens per minute on Opus 5.5, Sonnet 5.5 and Haiku 5.5. Cache reads do not count toward the input-tokens-per-minute limit. Responses carry `anthropic-ratelimit-*` headers.

### Rough cost model for one agentic coding session

These are my assumptions, not Anthropic figures. A session makes 60 model requests (turns plus tool calls). The context grows to an average of about 70K tokens per request. Each request adds about 3K new tokens, written to a 5-minute cache. That gives roughly **4.0M cache-read tokens, 0.18M cache-write tokens and 0.15M output tokens**, including thinking.

| Model | Cache reads | Cache writes | Output | Total |
|---|---|---|---|---|
| Opus 5.5 | 4.0 × $0.20 = $0.80 | 0.18 × $5 = $0.90 | 0.15 × $20 = $3.00 | **≈ $4.70** |
| Sonnet 5.5 | 4.0 × $0.10 = $0.40 | 0.18 × $2.50 = $0.45 | 0.15 × $10 = $1.50 | **≈ $2.35** |
| Haiku 5.5 (prompts ≤ 100K) | $0.04 | $0.02 | $0.08 | **≈ $0.14** (about 5x that if prompts go over 100K) |

What follows from the model:

- **Output, mostly thinking, dominates the cost.** Effort level and model tier matter more than context size, provided the cache stays warm.
- **A cache miss is expensive.** On Opus 5.5, rebuilding a 100K-token context costs about $0.50 at the 5-minute write rate, against $0.02 to read it from cache. Idle gaps longer than the TTL are therefore costly.
- **The model roughly matches Anthropic's own figures.** Across enterprise deployments, Anthropic reports "around $13 per developer per active day and $150-250 per developer per month" ([costs](https://code.claude.com/docs/en/costs)).
- **What this means for the factory.** Four parallel runs completing about 24 Sonnet-to-Opus-sized sessions a day would cost about **$55–115 per day** on the API, which is several hundred to a few thousand dollars a month. Max 20x costs $200/month. The subscription is far cheaper per unit of work as long as the window holds. Anthropic publishes no token figure for that window, so the exact break-even cannot be computed.
- **Agent teams cost more.** Agent teams use "approximately 7x more tokens than standard sessions" when teammates run in plan mode ([costs](https://code.claude.com/docs/en/costs)). Delegation fan-out multiplies usage in the same way.

## 4. Can the factory read how much of the usage window is left?

Yes, through Claude Code itself. There is no dedicated public API for it.

| Mechanism | What it returns | Conditions | Source |
|---|---|---|---|
| Status-line stdin JSON | `rate_limits.five_hour.used_percentage`, `rate_limits.five_hour.resets_at` (epoch s), and the same fields for `seven_day` | "only for claude.ai Pro and Max subscribers… and only after the first API response". Each window can be missing. Interactive sessions only. | [statusline](https://code.claude.com/docs/en/statusline) |
| Agent SDK `SDKRateLimitEvent` (`type: "rate_limit_event"`) | `status: "allowed" \| "allowed_warning" \| "rejected"`, `resetsAt`, `utilization`, and `errorCode: "credits_required"` when the included usage is used up | Emitted on the SDK message stream | [TS SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) |
| `/usage` sent as a prompt through the SDK → `usage_report.rate_limits.limits[]` | `kind`, `percent`, `resets_at`, `scope.model`, `severity`, plus `extra_usage` spend | **Experimental** (SDK v0.3.273+). Needs a claude.ai credential with the `user:profile` scope. **A `setup-token` token does not qualify by default**, because it carries only `user:inference`. | [TS SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) |
| Interactive `/usage` and `/status` | Plan usage bars, a 24-hour or 7-day attribution breakdown, and usage-credit spend | Human-facing. The endpoint behind it is rate-limited, so `/usage` falls back to bars "within the past 60 minutes". | [costs](https://code.claude.com/docs/en/costs), [support](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan) |
| claude.ai Settings > Usage | Bars and the weekly reset time | Web UI only | support articles above |
| API key path | `anthropic-ratelimit-*` headers, the Console Usage/Cost pages, and the Usage and Cost API. Agent SDK `total_cost_usd` / `modelUsage` give client-side **estimates**. | API billing only | [rate limits](https://platform.claude.com/docs/en/api/rate-limits), [cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) |

Related behaviour: from v2.1.234, Claude Code can wait for a usage-limit reset and continue an interrupted task on its own (`autoContinueAtUsageLimit`, `/rate-limit-options`). It re-arms this wait "at most twice in a row" ([interactive mode](https://code.claude.com/docs/en/interactive-mode)).

## 5. Implications for the executor and the quota-aware scheduler

1. **Use the subscription first, through the unmodified binary.** Drive runs through the Agent SDK or `claude -p` with the operator's `/login` credential. The factory never reads, copies or stores `.credentials.json` or claude.ai tokens. Keep `ANTHROPIC_API_KEY` out of subscription run environments, and never use `--bare` for those runs.
2. **Plan sizing.** Pro is fine for the first single-run trials. Its weekly wrap-up allowance applies only once per week, and it gets no API credits. Move to **Max 5x** when two or more parallel runs routinely exhaust the 5-hour window. Move to **Max 20x** only when the weekly cap binds. Max 20x also adds $200/month of API credits.
3. **Two budgets with different units.** The scheduler must track two things:
   - **Subscription window**: two percentages, 5-hour and weekly, plus a reset time each. The unit is opaque, and the pool is shared with the operator's own chat and IDE use, so the factory sees usage it did not cause.
   - **API dollars**: Max credits, plus any purchased credits, capped by a workspace spend limit and estimated from `total_cost_usd`.
4. **Check before each run.** Read the last known `utilization` and `resetsAt` from the stream (`rate_limit_event`), refreshed by a periodic `/usage` probe in an SDK session that holds a `user:profile`-scoped credential. Hold new runs when either window is above a threshold. On `rejected`, pause the queue until `resetsAt`, or route eligible runs to the API-key executor. Decide whether to disable `autoContinueAtUsageLimit` so the factory, not Claude Code, owns the retry.
5. **Cost-aware behaviour.** Model tier and effort level drive usage on both paths, so the routing seam should default to Sonnet or Haiku for children and Opus only for the stages that need it. Avoid idle gaps longer than the cache TTL inside a run: 1 hour on a subscription, 5 minutes on an API key unless `ENABLE_PROMPT_CACHING_1H` is set. Account for delegation fan-out as roughly linear in the number of children.
6. **Usage credits.** Leave subscription usage credits off, or capped, by default. When they are on, runs silently switch to API rates and the cache TTL drops to 5 minutes.
7. **Policy hedge.** Keep the credential choice behind the executor seam (subscription versus API key versus a cloud provider) so the factory survives a change to the paused Agent SDK policy. Record this as an ADR risk.

## Open points

- The token size of the 5-hour and weekly windows per plan is unpublished. It can only be measured empirically, for example by logging `utilization` deltas against `modelUsage`.
- What the paused June 2026 "changes to Claude Agent SDK usage" contained is not documented on any primary page I found.
- Whether status-line `rate_limits` and `rate_limit_event.utilization` populate when the credential is a `setup-token` token is not documented. This needs a quick prototype check.
