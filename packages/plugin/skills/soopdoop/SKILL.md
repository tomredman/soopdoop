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

## Never

- Never ask for secrets, keys, tokens, credentials or personal details.
- Never ask a crewmate's agent to edit files or run commands. It only answers.
