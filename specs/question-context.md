# Question answers after compaction

The durable session runner restores completed `question` exchanges from the original transcript after both summary and native compaction. It adds a model-input-only user-context block, without creating a user turn or waking an idle session. The block identifies questions/options as assistant-authored and answers as verbatim historical user replies, not necessarily decisions; later corrections take precedence.

Restoration follows official message creation order and tool content order, with one completion timestamp per exchange. Unfinished or dismissed tools are not answers. Missing replies remain explicitly unanswered. Exact unambiguous option selections keep the selected labels/descriptions; custom, mixed, empty, ambiguous or reference-dependent answers retain all options. The small Chinese/English reference heuristics only reduce redundant context; they are not semantic classification. Questions and answers are never summarized or truncated.

The original projected tool records are authoritative. The runner caches decoded exchanges once per selected checkpoint within its current drain; restart, a new checkpoint, fork and revert use the applicable remaining transcript. No second durable question-answer journal is introduced.

Only intact structured question calls and results already present in the model input suppress restoration. Truncated results remain restorable. Upstream summary `recent` is serialized text whose tool results may be truncated; it is not used to infer completeness. Some duplication with that text is accepted in exchange for preserving the original answers without a local compaction index.

Restoration is added only to primary model requests, after compaction decisions and separately from the stored history. It does not enter native retained-user selection or become an additional serialized-tail message. Its input cost grows with question history, as in the previous local implementation. V2 no longer has the old output-pruning pass; no obsolete pruning machinery is restored.
