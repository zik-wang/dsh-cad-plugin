"""Bounded hand-offs between source reading, candidate self-check and independent review."""
import json,hashlib
def require_execution_stage(root):
    task=json.loads((root/'input.json').read_text(encoding='utf-8'))
    if task.get('protocol')!='cad-desktop-v2':return
    if not (root/'.host/contract.json').exists():
        raise RuntimeError('CAD source stage is not complete. Use cad_view for source crops and cad_contract BEFORE custom Python. Do not fit decorative pixels before establishing the controlled geometry.')
    needed=['drawing.dxf','model_1to1.dxf','drawing.pdf','drawing.png','drawing_librecad.pdf','drawing_librecad.png']
    if not all((root/'artifacts'/n).exists() for n in needed):return
    preflight=root/'.host/preflight.json'
    if preflight.exists():
        p=json.loads(preflight.read_text(encoding='utf-8'))
        same=p.get('source_revision')==task.get('revision',0) and all((root/n).exists() and hashlib.sha256((root/n).read_bytes()).hexdigest()==h for n,h in p.get('files',{}).items())
        if p.get('passed') and same:
            reviews=sorted((root/'.host').glob('native-review-*.json'))
            if not reviews or reviews[-1].stat().st_mtime<preflight.stat().st_mtime:
                raise RuntimeError('Deterministic preflight passed. The next stage is cad_review, not more self-polishing scripts. Call cad_review on this unchanged candidate; then fix only its evidenced findings.')
    events_file=root/'.host/events.jsonl'
    if not events_file.exists():return
    events=[json.loads(line) for line in events_file.read_text(encoding='utf-8').splitlines() if line.strip()]
    exports=[i for i,e in enumerate(events) if e.get('type')=='call' and e.get('name')=='cad_export' and e.get('args',{}).get('dxf')=='artifacts/drawing.dxf']
    checks=[i for i,e in enumerate(events) if e.get('type')=='call' and e.get('name')=='cad_preflight']
    if not exports:return
    start=max(exports[0],checks[-1] if checks else 0)
    scripts=sum(e.get('type')=='call' and e.get('name')=='cad_python' for e in events[start:])
    if scripts>=8:
        raise RuntimeError('A complete candidate already exists and this self-check stage has used eight Python calls. Call cad_preflight now. Resolve its concrete errors, then call cad_review; avoid another round of font/arrow pixel fitting before independent feedback.')
