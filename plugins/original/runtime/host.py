"""Generic image viewing / DXF export utilities. Contains no part geometry."""
import sys,json,os,uuid,hashlib,subprocess,math,re
for variable in ('OPENBLAS_NUM_THREADS','OMP_NUM_THREADS','MKL_NUM_THREADS'):
    os.environ[variable]='1'
from pathlib import Path
from PIL import Image
import ezdxf,pymupdf
from ezdxf.addons.drawing import Frontend,RenderContext,layout,config,pymupdf as pdf_backend
from ezdxf.addons import text2path
from ezdxf.addons.mtxpl import MTextExplode
from ezdxf.math import BoundingBox2d
from cad_pdf_backend import CadPdfBackend
from cad_features import contract,build_feature,preflight
from workflow_stage import require_execution_stage
ROOT=Path(os.environ['INDEPENDENT_CAD_JOB']).resolve()
def scoped(p):
    result=(ROOT/p).resolve();assert result.is_relative_to(ROOT),'Outside task';return result
def render_preview(page, output, requested_dpi=600, max_pixels=36_000_000):
    """Raster preview only: preserve PDF vectors; bound memory for large sheets."""
    rect=page.rect
    limit=72*math.sqrt(max_pixels/(rect.width*rect.height))
    dpi=max(1,min(int(requested_dpi),int(limit)))
    while math.ceil(rect.width*dpi/72)*math.ceil(rect.height*dpi/72)>max_pixels:
        dpi-=1
    pix=page.get_pixmap(dpi=dpi,colorspace=pymupdf.csRGB,alpha=False)
    pix.save(output)
    return {'requested_dpi':requested_dpi,'dpi':dpi,'pixels':[pix.width,pix.height],
            'pixel_budget_limited':dpi<requested_dpi,'max_pixels':max_pixels,
            'scope':'Raster sampling only; inspect PDF vector crops for smaller detail. No geometry or lineweight changes.'}
def crop(a):
    source=scoped(a['path']);region=a.get('region') or [0,0,1,1];assert len(region)==4 and 0<=region[0]<region[2]<=1 and 0<=region[1]<region[3]<=1
    if source.suffix.lower()=='.pdf':
        d=pymupdf.open(source);pg=d[int(a.get('page',0))];rect=pg.rect
        clip=pymupdf.Rect(rect.x0+region[0]*rect.width,rect.y0+region[1]*rect.height,rect.x0+region[2]*rect.width,rect.y0+region[3]*rect.height)
        zoom=2400/max(clip.width,clip.height)
        pix=pg.get_pixmap(matrix=pymupdf.Matrix(zoom,zoom),clip=clip,colorspace=pymupdf.csRGB,alpha=False)
        im=Image.frombytes('RGB',[pix.width,pix.height],pix.samples);d.close()
    else:
        im=Image.open(source).convert('RGB');w,h=im.size
        im=im.crop((round(region[0]*w),round(region[1]*h),round(region[2]*w),round(region[3]*h)))
    im.thumbnail((2400,2400))
    out=ROOT/'.host'/('view-'+uuid.uuid4().hex[:8]+'.png');im.save(out)
    return {'path':str(out),'pixels':list(im.size),'sha256':hashlib.sha256(out.read_bytes()).hexdigest()}
def export(a):
    require_execution_stage(ROOT)
    source=scoped(a['dxf']);assert source.suffix.lower()=='.dxf'
    w,h=float(a['width_mm']),float(a['height_mm']);assert 50<=w<=1500 and 50<=h<=1500
    source_hash=hashlib.sha256(source.read_bytes()).hexdigest()
    prefix=source.with_suffix('');d=ezdxf.readfile(source);aud=d.audit();assert not aud.errors,'DXF audit errors'
    # Promote actual effective dimension overrides for CAD readers that ignore override XDATA.
    for i,e in enumerate(d.modelspace().query('DIMENSION')):
        st=d.dimstyles.duplicate_entry(e.dxf.dimstyle,f'EXPORT_DIM_{i}_{uuid.uuid4().hex[:4]}');st.dxf.update(e.override().dimstyle_attribs);e.dxf.dimstyle=st.dxf.name;e.discard_xdata('ACAD')
    printable=prefix.with_name(prefix.name+'_print.dxf');d.saveas(printable)
    bk=CadPdfBackend();cfg=config.Configuration(background_policy=config.BackgroundPolicy.WHITE,color_policy=config.ColorPolicy.COLOR,lineweight_policy=config.LineweightPolicy.ABSOLUTE,min_lineweight=.01*300/25.4)
    Frontend(RenderContext(d),bk,config=cfg).draw_layout(d.modelspace(),finalize=True)
    pdf=prefix.with_suffix('.pdf');pdf.write_bytes(bk.get_pdf_bytes(layout.Page(w,h),settings=layout.Settings(fit_page=False,scale=1),render_box=BoundingBox2d([(0,0),(w,h)])))
    pd=pymupdf.open(pdf);pd[0].set_mediabox(pymupdf.Rect(0,0,w*72/25.4,h*72/25.4));pd.saveIncr();preview=prefix.with_suffix('.png');main_preview=render_preview(pd[0],preview)
    for e in list(d.modelspace().query('DIMENSION')):
        for child in e.explode():child.dxf.layer='0';child.dxf.lineweight=13
    for space in [d.modelspace(),*list(d.blocks)]:
        with MTextExplode(space) as ex:
            for e in list(space.query('MTEXT')):ex.explode(e)
        for e in list(space.query('TEXT ATTRIB')):text2path.explode(e,kind=text2path.Kind.HATCHES,target=space)
        for e in space:
            if e.dxf.hasattr('color') and e.dxf.color==0:e.dxf.color=256
            if e.dxftype()=='HATCH':e.paths.edge_to_polyline_paths(distance=.002,segments=8)
    d.dxfversion='AC1024';compatible=prefix.with_name(prefix.name+'_compatible.dxf');d.saveas(compatible)
    lc=prefix.with_name(prefix.name+'_librecad.pdf')
    cp=subprocess.run([a['librecad'],'dxf2pdf','-c','-s','1','-p',f'{w:g}x{h:g}','-o',lc.as_posix(),compatible.as_posix()],capture_output=True,timeout=120)
    (ROOT/'.host/librecad.log').write_bytes(cp.stdout+cp.stderr)
    assert cp.returncode==0 and lc.exists(),'LibreCAD export failed'
    check=pymupdf.open(lc);lc_preview=render_preview(check[0],prefix.with_name(prefix.name+'_librecad.png'))
    assert hashlib.sha256(source.read_bytes()).hexdigest()==source_hash,'DXF changed during export'
    receipt_files=[source,pdf,preview,lc,prefix.with_name(prefix.name+'_librecad.png')]
    receipt_name='export-receipt.json' if source==ROOT/'artifacts/drawing.dxf' else 'probe-export-'+hashlib.sha256(str(source).encode()).hexdigest()[:12]+'.json'
    preview_rendering={'main':main_preview,'librecad':lc_preview}
    (ROOT/'.host'/receipt_name).write_text(json.dumps({'files':{str(p.relative_to(ROOT)).replace('\\','/'):hashlib.sha256(p.read_bytes()).hexdigest() for p in receipt_files},'page_mm':[w,h],'backend':'CAD vector export plus LibreCAD independent readback','preview_rendering':preview_rendering}),encoding='utf-8')
    return {'pdf':str(pdf.relative_to(ROOT)),'preview':str(preview.relative_to(ROOT)),'print_dxf':str(printable.relative_to(ROOT)),'compatible':str(compatible.relative_to(ROOT)),'librecad_pdf':str(lc.relative_to(ROOT)),'dxf_audit_errors':len(aud.errors),'dxf_audit_fixes':len(aud.fixes),'pdf_page_mm':[w,h],'pdf_images':len(pd[0].get_images()),'preview_rendering':preview_rendering,'stroke_policy':{'join':'miter','cap':'butt','minimum_mm':.01,'geometry_changed':False,'pdf_crops':'vector rerender up to 2400px'},'scope':'Export/readability only. Does not validate source dimensions or geometry.'}
def inspect(a):
    d=ezdxf.readfile(scoped(a['dxf']));au=d.audit();counts={}
    for e in d.modelspace():counts[e.dxftype()]=counts.get(e.dxftype(),0)+1
    from ezdxf import bbox
    geometry=[]
    for b in d.blocks:
        if b.name.startswith('*'):continue
        angles={};radii={};parts=list(b.query('LINE LWPOLYLINE POLYLINE CIRCLE ARC ELLIPSE SPLINE'))
        for e in b.query('LINE'):
            delta=e.dxf.end-e.dxf.start
            if delta.magnitude>1e-10:
                key=f'{math.degrees(math.atan2(delta.y,delta.x))%180:.4f}'
                angles[key]=angles.get(key,0)+1
        for e in b.query('CIRCLE ARC'):
            key=f'{e.dxf.radius:.8g}';radii[key]=radii.get(key,0)+1
        bounds=bbox.extents(parts)
        geometry.append({'name':b.name,'entities':len(b),'line_angles_deg_mod180':angles,'radii':radii,'geometry_bounds':[list(bounds.extmin),list(bounds.extmax)] if bounds.has_data else None})
    paths=[]
    for e in sorted(d.modelspace().query('LWPOLYLINE'),key=lambda x:len(x),reverse=True)[:12]:
        pts=list(e.get_points('xyb'));angles={}
        pairs=list(zip(pts,pts[1:]))
        if e.closed and pts:pairs.append((pts[-1],pts[0]))
        for p,q in pairs:
            if p[2] or math.hypot(q[0]-p[0],q[1]-p[1])<1e-10:continue
            key=f'{math.degrees(math.atan2(q[1]-p[1],q[0]-p[0]))%180:.4f}'
            angles[key]=angles.get(key,0)+1
        if pts:paths.append({'layer':e.dxf.layer,'vertices':len(pts),'closed':bool(e.closed),'bounds':[[min(p[0] for p in pts),min(p[1] for p in pts)],[max(p[0] for p in pts),max(p[1] for p in pts)]],'straight_segment_angles_deg_mod180':angles})
    dims=[];warnings=[]
    for e in d.modelspace().query('DIMENSION'):
        measured=e.get_measurement();factor=e.override().get('dimlfac',1);kind=e.dimtype
        row={'text':e.dxf.text,'measurement':measured,'dimtype':e.dxf.dimtype,'linear_scale_factor':factor};dims.append(row)
        raw=e.dxf.text
        if not raw or '<>' in raw or not isinstance(measured,(float,int)):continue
        text=re.sub(r'^[\s*Δ△(ΦØ⌀]+','',raw.replace('%%c','').replace('%%C',''))
        text=re.sub(r'^\d+\s*(?:[xX×]\s*\d+\s*)?[-–]\s*(?=\d)','',text)
        compound=re.match(r'^(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)',text)
        number=re.match(r'^([+-]?\d+(?:\.\d+)?)',text)
        if not number:continue
        nominal=float(compound[2]) if compound else float(number[1]);nominals=[nominal]
        if compound:nominals.append(nominal*int(compound[1]))
        values=[float(measured)] if kind in (2,5) else [float(measured)*float(factor)]
        if kind in (2,5):values.append(360-float(measured))
        gap=min(abs(x-y) for x in nominals for y in values)
        if gap>1e-4:warnings.append({'text':raw,'nominal_candidates':nominals,'measured_candidates':values,'difference':gap,'meaning':'Dimension override differs from measured definition points. Verify source and geometry; do not change original nominal text just to silence this warning.'})
    return {'units':d.units,'errors':len(au.errors),'fixes':len(au.fixes),'entities':counts,'blocks':geometry,'modelspace_longest_polylines':paths,'inserts':[{'block':e.dxf.name,'scale':[e.dxf.xscale,e.dxf.yscale,e.dxf.zscale],'at':list(e.dxf.insert)} for e in d.modelspace().query('INSERT')],'dimensions':dims,'nominal_measurement_warnings':warnings}
if __name__=='__main__':
    a=json.load(sys.stdin);print(json.dumps({'crop':crop,'export':export,'inspect':inspect,'contract':contract,'feature':build_feature,'preflight':preflight}[a.pop('action')](a),ensure_ascii=False,default=list))
