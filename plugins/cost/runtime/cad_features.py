"""Deterministic, parameter-only CAD helpers; contains no drawing-specific values."""
import json, math, hashlib, re, os
from pathlib import Path
import ezdxf
import pymupdf
from PIL import Image

ROOT=Path(os.environ['INDEPENDENT_CAD_JOB']).resolve()
def scoped(name):
    p=(ROOT/name).resolve()
    if not p.is_relative_to(ROOT): raise ValueError('Outside task')
    return p
def load(name): return json.loads(scoped(name).read_text(encoding='utf-8'))
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p,value):
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
def finite(value,label):
    value=float(value)
    if not math.isfinite(value): raise ValueError(label+' must be finite')
    return value
def evidence(row,sources):
    if not isinstance(row,dict) or row.get('path') not in sources: raise ValueError('Evidence must identify a source image')
    r=row.get('region',[])
    if len(r)!=4 or not (0<=r[0]<r[2]<=1 and 0<=r[1]<r[3]<=1): raise ValueError('Source region must be normalized [left,top,right,bottom]')

def contract(a):
    ledger=load(a['path']);task=load('input.json')
    sources={s['path'] for s in task.get('sources',[{'path':task['source']}])}
    if ledger.get('units')!='mm': raise ValueError('Contract geometry must use millimetres')
    paper=ledger.get('paper_mm',[])
    if len(paper)!=2 or not all(50<=finite(v,'paper')<=1500 for v in paper): raise ValueError('Invalid paper_mm')
    if not ledger.get('views') or not ledger.get('dimensions'): raise ValueError('Record views and dimensions first')
    names=set()
    for v in ledger['views']:
        if not v.get('id') or v['id'] in names: raise ValueError('Unique view ids required')
        names.add(v['id'])
        if finite(v.get('scale',0),'view scale')<=0 or not v.get('block'): raise ValueError('Each view needs a block name and positive scale')
        evidence(v.get('source'),sources)
    unresolved=[]
    for d in ledger['dimensions']:
        if d.get('view') not in names or d.get('kind') not in ['controlled','reference','derived','uncertain']: raise ValueError('Invalid dimension view/kind')
        if d['kind']!='uncertain': finite(d.get('value'),'dimension value')
        if d['kind'] in ['controlled','reference','uncertain']: evidence(d.get('source'),sources)
        elif not d.get('expression'): raise ValueError('Derived values need an expression and named inputs')
        if d['kind']=='uncertain' and d.get('critical',True): unresolved.append(d.get('id','unnamed'))
    record={'contract':ledger,'source_revision':task.get('revision',0),'source_hashes':{s:digest(scoped(s)) for s in sources},'ledger_sha256':digest(scoped(a['path'])),'unresolved_critical':unresolved}
    save(ROOT/'.host/contract.json',record)
    return {'saved':'.host/contract.json','views':len(ledger['views']),'dimensions':len(ledger['dimensions']),'unresolved_critical':unresolved,'scope':'Schema and provenance only; DSH must verify values against source pixels.'}

def runout_geometry(spec):
    """Intersect a tilted extruded V profile (optionally root-filleted) with a descending plane.

    Width is measured along global X at fixed Y. Plane: z=-slope*(y-mouth_y).
    Groove axis: x=center+y*tan(tilt_deg). This explicit convention avoids
    silently confusing perpendicular groove width with projected X width.
    """
    if spec.get('width_direction')!='global_x': raise ValueError('Set width_direction=global_x; convert perpendicular widths explicitly first')
    width=finite(spec['opening_mm'],'opening');angle=finite(spec['included_angle_deg'],'angle')
    radius=finite(spec.get('root_radius_mm',0),'radius');slope=finite(spec['chamfer_drop_per_mm'],'slope')
    y0=finite(spec['mouth_y_mm'],'mouth y');tilt=finite(spec.get('axis_tilt_deg',0),'tilt');tol=finite(spec.get('chord_error_mm',0.0001),'chord error')
    if width<=0 or not 1<angle<179 or radius<0 or slope<=0 or tol<=0 or abs(tilt)>=80: raise ValueError('Invalid profile or chamfer parameters')
    half=math.radians(angle/2);t=math.tan(math.radians(tilt));apex=width/(2*math.tan(half))
    tangent_x=radius*math.cos(half)
    if tangent_x>=width/2: raise ValueError('Root fillet consumes the entire V wall')
    center_z=-apex+radius/math.sin(half) if radius else -apex
    profile=[(-width/2,0)]
    if radius:
        trace=1+(t*t+1)/(slope*slope);det=1/(slope*slope)
        stretch=math.sqrt((trace+math.sqrt(max(0,trace*trace-4*det)))/2)
        delta=2*math.acos(max(-1,min(1,1-tol/(radius*stretch))))
        count=max(2,math.ceil((math.pi-2*half)/max(delta,1e-9)))
        if count>10000: raise ValueError('Requested chord tolerance is unnecessarily small')
        for i in range(count+1):
            theta=math.pi+half+(math.pi-2*half)*i/count
            profile.append((radius*math.cos(theta),center_z+radius*math.sin(theta)))
    else: profile.append((0,-apex))
    profile.append((width/2,0))
    centers=[finite(c,'center') for c in spec['centers_mm']]
    if not centers or len(centers)>4096: raise ValueError('Supply 1..4096 groove centers read/derived by DSH')
    caps=[]
    for c in centers:
        caps.append([(c+(y0-z/slope)*t+x,y0-z/slope) for x,z in profile])
    return {'profile':profile,'caps':caps,'centers':centers,'theoretical_apex_depth_mm':apex,'actual_root_depth_mm':-(center_z-radius) if radius else apex,'root_radius_mm':radius,'chord_error_mm':tol,'axis_tilt_deg':tilt,'mouth_y_mm':y0,'half_angle_rad':half,'root_center_z':center_z}

def build_feature(a):
    spec=load(a['path']);identity=spec.get('id','')
    if not re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,35}',identity): raise ValueError('Use a short unique ASCII feature id')
    if spec.get('type')!='v_groove_chamfer_runout': raise ValueError('Supported type: v_groove_chamfer_runout; use cad_python for other geometry')
    g=runout_geometry(spec);doc=ezdxf.new('R2010');doc.units=4
    doc.layers.new('CAD_FINE',dxfattribs={'lineweight':0});doc.appids.new('CAD_FEATURE')
    plan_name='F_'+identity+'_PLAN';section_name='F_'+identity+'_SECTION'
    plan=doc.blocks.new(plan_name);section=doc.blocks.new(section_name)
    for i,pts in enumerate(g['caps']):
        e=plan.add_lwpolyline(pts,dxfattribs={'layer':'CAD_FINE'});e.set_xdata('CAD_FEATURE',[(1000,identity),(1070,i)])
    p=g['profile'];r=g['root_radius_mm']
    section.add_line(p[0],p[1],dxfattribs={'layer':'CAD_FINE'})
    if r:
        alpha=math.degrees(g['half_angle_rad']);section.add_arc((0,g['root_center_z']),r,180+alpha,360-alpha,dxfattribs={'layer':'CAD_FINE'})
        section.add_line(p[-2],p[-1],dxfattribs={'layer':'CAD_FINE'})
    else: section.add_line(p[1],p[2],dxfattribs={'layer':'CAD_FINE'})
    doc.modelspace().add_blockref(plan_name,(0,0))
    target=ROOT/'.host/features'/identity;target.parent.mkdir(parents=True,exist_ok=True);doc.saveas(target.with_suffix('.dxf'))
    record={'id':identity,'type':spec['type'],'parameters':spec,'geometry':g,'blocks':{'plan':plan_name,'section':section_name},'sha256':digest(target.with_suffix('.dxf')),'geometry_signature':{plan_name:signature(plan),section_name:signature(section)}}
    save(target.with_suffix('.json'),record)
    return {'dxf':str(target.with_suffix('.dxf').relative_to(ROOT)),'record':str(target.with_suffix('.json').relative_to(ROOT)),'blocks':record['blocks'],'feature_count':len(g['caps']),'theoretical_depth_mm':g['theoretical_apex_depth_mm'],'actual_depth_mm':g['actual_root_depth_mm'],'root_radius_preserved_mm':r,'max_plan_chord_error_mm':g['chord_error_mm'],'usage':'Import the named blocks using ezdxf.addons.Importer.import_blocks(...); finalize(). Insert at scale 1 in model_1to1 and the explicit source scale in drawing. Do not replace real rounded endings with decorative sharp Vs.'}

def signature(block,seen=None):
    seen=set(seen or [])
    if block.name in seen:raise ValueError('Cyclic geometry block: '+block.name)
    seen.add(block.name)
    rows=[]
    for e in block:
        kind=e.dxftype();attrs=e.dxfattribs()
        if kind not in ['LINE','LWPOLYLINE','POLYLINE','ARC','CIRCLE','ELLIPSE','SPLINE','INSERT']: continue
        keys=['start','end','center','radius','start_angle','end_angle','insert','name','xscale','yscale','rotation','major_axis','ratio']
        row={'type':kind,**{k:attrs[k] for k in keys if k in attrs}}
        if kind=='LWPOLYLINE':row.update(points=list(e.get_points('xyb')),closed=e.closed)
        if kind=='POLYLINE':row['points']=[list(v.dxf.location) for v in e.vertices]
        if kind=='SPLINE':row.update(control_points=list(e.control_points),knots=list(e.knots))
        if kind=='INSERT' and e.dxf.name in block.doc.blocks:row['nested_geometry']=signature(block.doc.blocks[e.dxf.name],seen)
        def clean(v):
            if isinstance(v,float): return round(v,8)
            if isinstance(v,(str,int,bool)) or v is None:return v
            if isinstance(v,dict):return {k:clean(x) for k,x in v.items()}
            return [clean(x) for x in v]
        rows.append(json.dumps(clean(row),sort_keys=True))
    return hashlib.sha256('\n'.join(sorted(rows)).encode()).hexdigest()

def preflight(a):
    task=load('input.json');issues=[];files={};readbacks={}
    for n in ['drawing.dxf','model_1to1.dxf','drawing.pdf','drawing.png','drawing_librecad.pdf','drawing_librecad.png']:
        p=scoped('artifacts/'+n)
        if not p.exists():issues.append('Missing '+n)
        else: files['artifacts/'+n]=digest(p)
    docs={}
    receipt=load('.host/export-receipt.json') if scoped('.host/export-receipt.json').exists() else None
    if not receipt:issues.append('Missing cad_export receipt')
    else:
        for n,h in receipt['files'].items():
            if not scoped(n).exists() or digest(scoped(n))!=h:issues.append('Export is stale or altered: '+n)
    for n in ['drawing.pdf','drawing_librecad.pdf']:
        if scoped('artifacts/'+n).exists():
            try:
                pdf=pymupdf.open(scoped('artifacts/'+n))
                if len(pdf)!=1:issues.append(n+': expected one sheet')
                elif receipt and any(abs(a-b)>.5 for a,b in zip((pdf[0].rect.width*25.4/72,pdf[0].rect.height*25.4/72),receipt['page_mm'])):issues.append(n+': paper size does not match export')
                if pdf[0].get_images():issues.append(n+': embedded raster images require explicit review; CAD sheet should be vector')
                pdf.close()
            except Exception:issues.append('Invalid PDF: '+n)
    for n in ['drawing.png','drawing_librecad.png']:
        if scoped('artifacts/'+n).exists():
            try:
                with Image.open(scoped('artifacts/'+n)) as im:im.verify()
            except Exception:issues.append('Invalid preview image: '+n)
    for n in ['drawing.dxf','model_1to1.dxf']:
        if scoped('artifacts/'+n).exists():
            d=ezdxf.readfile(scoped('artifacts/'+n));docs[n]=d;au=d.audit();readbacks[n]={'units':d.units,'errors':len(au.errors)}
            if d.units!=4 or au.errors:issues.append(n+': non-mm units or DXF errors')
    record=load('.host/contract.json') if scoped('.host/contract.json').exists() else None
    if not record:issues.append('Call cad_contract with your source evidence ledger')
    else:
        if record['source_revision']!=task.get('revision',0):issues.append('Contract predates current source revision')
        if receipt and any(abs(a-b)>1e-6 for a,b in zip(record['contract']['paper_mm'],receipt['page_mm'])):issues.append('Export paper differs from the source contract')
        for n,h in record['source_hashes'].items():
            if digest(scoped(n))!=h:issues.append('Contract source hash changed: '+n)
        issues.extend('Unresolved controlled dimension: '+x for x in record['unresolved_critical'])
        for v in record['contract']['views']:
            b=v['block']
            for n,d in docs.items():
                expected=v['scale'] if n=='drawing.dxf' else 1
                refs=[e for e in d.modelspace().query('INSERT') if e.dxf.name==b]
                if not refs:issues.append(n+': missing view block insertion '+b)
                for e in refs:
                    if abs(e.dxf.xscale-expected)>1e-9 or abs(e.dxf.yscale-expected)>1e-9:issues.append(n+': wrong scale of '+b)
            if len(docs)==2 and all(b in d.blocks for d in docs.values()):
                if signature(docs['drawing.dxf'].blocks[b])!=signature(docs['model_1to1.dxf'].blocks[b]):issues.append('Different base geometry between drawing and model: '+b)
    feature_results=[]
    def reachable(d):
        seen=set();todo=[e.dxf.name for e in d.modelspace().query('INSERT')]
        while todo:
            name=todo.pop()
            if name in seen or name not in d.blocks:continue
            seen.add(name);todo.extend(e.dxf.name for e in d.blocks[name].query('INSERT'))
        return seen
    for p in (ROOT/'.host/features').glob('*.json') if (ROOT/'.host/features').exists() else []:
        f=json.loads(p.read_text(encoding='utf-8'));used=0
        for n,d in docs.items():
            if f['blocks']['plan'] not in reachable(d):issues.append(n+': generated feature is not inserted into any visible view: '+f['id'])
            for b,h in f['geometry_signature'].items():
                if b in d.blocks:
                    used+=1
                    if signature(d.blocks[b])!=h:issues.append(n+': generated feature geometry was changed: '+b)
        feature_results.append({'id':f['id'],'feature_count':len(f['geometry']['caps']),'matching_blocks_present':used})
        if not used:issues.append('Generated feature was never imported: '+f['id'])
    report={'passed':not issues,'issues':issues,'source_revision':task.get('revision',0),'files':files,'readbacks':readbacks,'features':feature_results,'scope':'Deterministic checks of source binding, structure, scales and geometry consistency; independent DSH source review is still required.'}
    save(ROOT/'.host/preflight.json',report);return report
