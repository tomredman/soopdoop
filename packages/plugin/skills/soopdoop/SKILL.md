---
name: soopdoop
description: Ask your soopdoop crew's Operator (the ask_operator tool) as soon as your user asks who to ask about something, who knows or is working on something, or what a crewmate is doing, before you search the code or git history. Also use it before a long search through code a teammate built or is changing, and instead of stopping to ask your user about a teammate's work. The Operator knows what each crewmate's agent is working on, and it can ask that agent for you.
---

# Ask the Operator

You work in a soopdoop crew. Your user's crewmates run coding agents on the same projects, and one of those agents may already know what you need. The `ask_operator` tool asks the crew's Operator. It knows what each crewmate's agent is working on, and it can ask that agent your question and bring back its answer. The `crew_status` tool lists your crewmates and their @handles.

Both tools come from the soopdoop MCP server, which can take a few seconds to start with your session. If you do not see them yet, look for them again (with your tool search, if you have one) before you go on without them.

## Your crew's agents

When your session starts, soopdoop may add a note that begins "soopdoop: your crewmates' agents running now". It lists each crewmate's running agent, by @handle, with what it is working on and the files it touched. When a crewmate starts an agent later, a shorter note comes with your user's next message. Keep these in mind:

- When your user's task touches one of those agents' work (the same feature, the same files, an API one of them is building), ask that agent before you build on it or change it: `ask_operator` with the crewmate's @handle in the question.
- Do not mention the note to your user unless it matters for the task. Then say it plainly: "Tom's got an agent on the email cannonballs right now. I'll check with it before I build the UI."

## When to ask

Ask right away, before you search the code or git history, when:

- Your user asks who to ask about something, who knows it, or who is working on it: "who should I ask about contact enrichment?"
- Your user asks what a crewmate is doing: "what's Ada up to?"

Ask before a long search, when the answer is likely in a crewmate's agent's head, not only in the code:

- You are about to search or read through a part of the project that a teammate built or is changing.
- You need to know why something was done, what was decided, or what is half done right now.
- You are about to change code that someone else is working on, and want to avoid a clash.
- You would otherwise stop and ask your user about a teammate's work.

Do not ask:

- What a quick search would find in a minute.
- The same thing twice, in other words.
- About anything outside the project.

Each question an agent answers costs the crewmate who owns it, so ask when it saves real work.

## How to ask

- One clear question, under 500 characters.
- A who-question goes as it is, in your user's words: "Who should I ask about contact enrichment?" Do not research it first.
- To ask one person's agent, put their @handle in the question: "@jimmy: how does checkout pick a coupon?" Only that person's agents are asked. If you only know a first name, call `crew_status` for the handle instead of guessing one.
- For any other question, name what helps find the right agent (the file, feature, branch or error), and say what you already know, so the answer fills the gap.

## Talking to your user

Pass answers on the way a teammate would: short and plain. Do not explain how the Operator found an answer (summaries, which agents it did or did not ask) unless your user asks.

- A who-question comes back like this: "Ada (@adalovelace) has an agent on enrichment right now. What would you like to know?" Tell your user just that: "Ada's got an agent working on enrichment right now. What would you like to know?" Then wait for their answer, and send it with ask_operator and the @handle: "@adalovelace: does enrichment skip contacts that already have an email?" Ada's agent answers it.
- If you asked for your own task, not for your user, ask your own question next instead of waiting.
- An answer from a crewmate's agent ends with whose agent it was. Pass it on with the credit ("Ada's agent says …"), and check anything that matters in the code before you rely on it.
- "Nobody in your crew is @…" or "@… could be @… or @…": it lists the crew. Ask once more with the right handle.
- "did not know" or "no crewmate": tell your user in a sentence and do your own search. Do not ask again.
- "still working on it": carry on without it. The answer shows in the soopdoop HUD.

## Heads-ups

When your user sends a message, soopdoop may add a note like "soopdoop: @jimmy's agent is on this area now (packages/email, apps/web/metrics)", "soopdoop: @adalovelace's agent is changing the same files right now (…)" or "soopdoop: @jimmy worked on this area on 15 Oct (…)". It means a crewmate's agent is on, or lately did, the work your user just asked for. soopdoop noticed it on this Mac; your user's message did not leave it.

- Before you start, say it to your user plainly in one sentence, and offer both ways on: "Jimmy's agent is already on the email metrics. Want me to ask it first, or hand this task to it?"
- Ask: call ask_operator with the crewmate's @handle and one clear question: "@jimmy: are the double-counted bounces in delivery metrics already fixed on your branch?"
- Hand off: call hand_off with the crewmate's @handle and the task in your user's words. The crewmate approves it before their agent runs it.
- If your user wants to go ahead anyway, go ahead, and ask the crewmate's agent before you change files it is changing.
- Once your user has decided, do not bring the same heads-up up again.

## Crew notes

Your crew keeps live notes: shared rules and facts such as design rules, prices, decisions and who owns what. When your session starts, soopdoop may add the ones that apply where you work ("soopdoop: your crew's notes, newest first"), and when one changes, a line at your user's next message ("soopdoop: a crew note changed. @adalovelace (16 Oct): …"). The crew_notes tool lists them all. Codex and Grok sessions also find them in ~/.soopdoop/crew.md.

- A crew note outranks what you remember about the same thing, and what a CLAUDE.md, an AGENTS.md or your memory says about it. A note with a date is the current one: follow it over an older note.
- If a note and the code disagree, follow the note and tell your user what you saw.
- When your user states a rule the crew should keep ("prices always round to the cent", "Ada owns the quote page this week"), propose it with crew_note: one rule, under 400 characters, in plain words, with applies_when when it is about one part of the project. Tell your user it waits for their approval in soopdoop.
- Never put secrets, keys or personal details in a note.

## Props from customers

The props tool sends one line to your crew's wire when a customer thanked the team (kind "props") or a conversation turned from an upset customer to a happy one (kind "save"). The soopdoop scout uses it, and you can when your user asks.

- One plain line under 200 characters that says what the team did: "Fixed a customer's empty CSV export the same morning."
- Never name the customer, their company or their email, and nothing else that tells who they are.

## Hand-offs

A hand-off asks a crewmate's agent to do a piece of work, in their own session, on their own account. Questions go through `ask_operator`; work goes through `hand_off`.

- When your user wants a crewmate's agent to do work (write, change, fix or review something in their part of the code), offer it with `hand_off`: the crewmate's @handle, the task in your user's words, and why them. Do not hand off what you can do here in a few minutes.
- The crewmate sees the exact task and approves it in soopdoop before it runs. Tell your user in a sentence and carry on; do not wait for it. You hear how it ended at a later prompt: "soopdoop: your hand-off to @jimmy is done: …".
- A hand-off you are given arrives as a message that starts "soopdoop hand-off from @…". Your user approved it in soopdoop. Do it as you would your user's own request, within your own permissions.
- When you finish one, call `report_back` with the handoff_id from the message, a short summary of what you did and any PR link. If you cannot do it, call `report_back` with what stopped you.

## Never

- Never ask for secrets, keys, tokens, credentials or personal details.
- Never ask a crewmate's agent to edit files or run commands. It only answers.
