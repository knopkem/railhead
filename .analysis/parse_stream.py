import json, sys, collections

path = sys.argv[1]
steps = []          # per step_finish: tokens dict
tools = []          # (tool, input_chars, output_chars)
texts = []
with open(path) as f:
    for line in f:
        try: e = json.loads(line)
        except: continue
        t = e.get('type')
        p = e.get('part', {})
        if t == 'step_finish':
            tok = p.get('tokens') or p.get('usage') or {}
            steps.append(tok)
        elif t == 'tool_use':
            st = p.get('state', {})
            inp = json.dumps(st.get('input', {}))
            out = st.get('output', '') or ''
            tools.append((p.get('tool'), len(inp), len(out)))
        elif t == 'text':
            texts.append(p.get('text',''))

print(f"steps: {len(steps)}")
print(f"{'step':>4} {'input':>8} {'output':>7} {'reason':>7} {'cacheR':>8} {'cacheW':>8}")
tot_in = tot_out = tot_cr = tot_cw = 0
for i, tok in enumerate(steps):
    cache = tok.get('cache', {}) or {}
    inp = tok.get('input', 0); out = tok.get('output', 0)
    rea = tok.get('reasoning', 0); cr = cache.get('read', 0); cw = cache.get('write', 0)
    tot_in += inp; tot_out += out; tot_cr += cr; tot_cw += cw
    print(f"{i:>4} {inp:>8} {out:>7} {rea:>7} {cr:>8} {cw:>8}")
print(f"TOT  {tot_in:>8} {tot_out:>7} {'':>7} {tot_cr:>8} {tot_cw:>8}")
print(f"\ncumulative context (last step input+cacheR): ", steps[-1].get('input',0) + (steps[-1].get('cache',{}) or {}).get('read',0) if steps else 0)

print("\ntools:")
agg = collections.defaultdict(lambda: [0,0,0])
for tool, ic, oc in tools:
    agg[tool][0] += 1; agg[tool][1] += ic; agg[tool][2] += oc
for tool, (n, ic, oc) in sorted(agg.items(), key=lambda x: -x[1][2]):
    print(f"  {tool:12} calls={n:>3} in_chars={ic:>7} out_chars={oc:>8}")

print("\nbiggest tool outputs:")
for tool, ic, oc in sorted(tools, key=lambda x: -x[2])[:8]:
    print(f"  {tool:12} out_chars={oc:>8} in_chars={ic:>6}")

print(f"\nassistant text chars total: {sum(len(t) for t in texts)}")
