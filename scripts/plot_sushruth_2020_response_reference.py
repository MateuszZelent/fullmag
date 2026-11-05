"""Render pinned equation-reference data; no solver, fitting or interpolation."""
from pathlib import Path
import argparse
import hashlib
import json
import os

REFERENCE_SHA256S=('c270e663102c680d087fd952662ea2514b83dd51e9ef3eefa15334294bd93c6a',
                   '3fa8dd8400f906870c9e794a88dbfda902c74616ab54328d73b031d9fa2751cd')


def plot_figure3_reference(input_path,output_path):
    data=Path(input_path).read_bytes()
    digest=hashlib.sha256(data).hexdigest()
    if digest not in REFERENCE_SHA256S:
        raise ValueError('pinned reference data identity differs')
    reference=json.loads(data)
    if any(reference[k] for k in ('fullmag_solver_executed','boris_solver_executed','physics_qualified')):
        raise ValueError('reference cannot be presented as a qualified solver result')
    output=Path(output_path)
    if output.suffix.lower()!='.png':raise ValueError('output must be a PNG path')
    for path in (output,output.with_suffix('.svg'),output.with_suffix('.metadata.json')):
        if path.exists():raise FileExistsError(path)
    output.parent.mkdir(parents=True,exist_ok=True)
    os.environ.setdefault('MPLCONFIGDIR',str(output.parent/'mplconfig-figure3'))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.ticker import MaxNLocator
    import numpy as np

    frequency=np.asarray(reference['frequencies_hz'])/1e9
    mask=(frequency>=6)&(frequency<=9)
    rows={ (c['alpha'],c['antenna']):c for c in reference['cases'] }
    alphas=(.01,.03,.07,.1);colors={'S':'#2451A4','GS':'#C33A30','GSG':'#222C38'}
    with plt.rc_context({'font.family':'DejaVu Sans','font.size':11,'axes.spines.top':False,
                         'axes.spines.right':False,'axes.linewidth':.8,'savefig.facecolor':'white'}):
        fig,axes=plt.subplots(4,2,figsize=(10.6,10.8),sharex=True,layout='constrained')
        for col,kinds in enumerate([('S',),('GS','GSG')]):
            bound=max(abs(v[0])*rows[a,k]['figure3_display_multiplier'] for a in alphas
                      for k in kinds for i,v in enumerate(rows[a,k]['transmission']) if mask[i])
            for i,alpha in enumerate(alphas):
                ax=axes[i,col]
                for antenna in kinds:
                    case=rows[alpha,antenna];scale=case['figure3_display_multiplier']
                    values=np.asarray(case['transmission'])[:,0]*scale
                    ax.plot(frequency[mask],values[mask],color=colors[antenna],lw=1.65,label=antenna)
                ax.axhline(0,color='#8B939C',lw=.65)
                ax.axvline(7.5,color='#8B939C',ls='--',lw=1.)
                ax.set_xlim(6,9);ax.set_ylim(-1.12*bound,1.12*bound)
                ax.yaxis.set_major_locator(MaxNLocator(4));ax.grid(axis='x',alpha=.14)
                ax.text(.035,.89,f"({chr(97+i+4*col)})  α = {alpha:g}",transform=ax.transAxes,fontsize=11)
                ax.text(.965,.08,f"× {rows[alpha,kinds[0]]['figure3_display_multiplier']}",
                        ha='right',transform=ax.transAxes,color='#475569',fontsize=10)
                if i==0:ax.legend(loc='upper right',frameon=False,ncol=len(kinds))
                if i==3:ax.set_xlabel('Częstotliwość [GHz]')
        axes[0,0].set_title('Pojedynczy pasek S',loc='left',fontweight='bold',pad=12)
        axes[0,1].set_title('U-shaped GS i CPW GSG',loc='left',fontweight='bold',pad=12)
        fig.supylabel('Re(T) × mnożnik z Fig. 3 [1]',fontsize=12)
        fig.suptitle('Sushruth i in. (2020): wzorzec równań dla Fig. 3\n'
                     'Table I • FMR = 7,50 GHz • bez dopasowania do wykresu publikacji',
                     fontsize=14,fontweight='bold')
        fig.supxlabel('Model 1D cienkich pasków. Bez solvera Fullmaga i bez wykonania LLG.\n'
                      'L = 200 nm · g = 250 nm · s = 30 nm · r = 2 µm · t = 20 nm',fontsize=10)
        fig.savefig(output,dpi=180);fig.savefig(output.with_suffix('.svg'));plt.close(fig)
    metadata={'input_sha256':digest,'frequency_range_GHz':[6,9],
              'samples_per_curve_in_view':int(mask.sum()),'curves':12,'frequency_shift_applied_hz':0.,
              'amplitude_fit_applied':False,'interpolation_applied':False,'fullmag_solver_executed':False,
              'physics_qualified':False,'matplotlib_version':matplotlib.__version__,
              'png_sha256':hashlib.sha256(output.read_bytes()).hexdigest(),
              'svg_sha256':hashlib.sha256(output.with_suffix('.svg').read_bytes()).hexdigest()}
    output.with_suffix('.metadata.json').write_text(json.dumps(metadata,indent=2))
    return metadata


def measure_figure3_e_pixels(image):
    """Measure only the black GSG curve and gray stroke in fixed panel (e)."""
    import numpy as np
    if not isinstance(image,np.ndarray) or image.shape!=(1524,1015,3) or image.dtype!=np.uint8:
        raise ValueError('panel (e) requires the registered RGB uint8 raster shape')
    black=np.max(image[44:370],axis=2)<80
    axes=[]
    for first,last in ((575,605),(990,1015)):
        counts=black[:,first:last].sum(axis=0)
        if counts.max()<.9*black.shape[0]:raise ValueError('panel (e) vertical axis not found')
        axes.append(first+int(np.argmax(counts)))
    left,right=axes
    x0=left+3
    curve=np.max(image[47:367,x0:right-2],axis=2)<80
    annotations=[{'label':'panel (e)','bounds_xyxy':[590,45,660,100]},
                 {'label':'alpha = 0.01','bounds_xyxy':[850,45,1002,110]}]
    ticks=[{'label':'top-axis tick at x=726','bounds_xyxy':[724,45,729,52]},
           {'label':'top-axis tick at x=795','bounds_xyxy':[793,45,798,49]}]
    # Visible text and inward axis ticks, not frequency/amplitude curve filters.
    for annotation in annotations+ticks:
        ax,ay,bx,by=annotation['bounds_xyxy']
        curve[max(0,ay-47):max(0,by-47),max(0,ax-x0):max(0,bx-x0)]=False
    ys,xs=np.nonzero(curve)
    if not len(xs):raise ValueError('panel (e) black GSG curve not found')
    convert=lambda x:6+3*(float(x)-left)/(right-left)
    anchors={}
    for name,extreme in [('maximum',ys.min()),('minimum',ys.max())]:
        points=xs[ys==extreme]+x0
        anchors[name]={'frequency_ghz':convert(points.mean()),
                       'stroke_frequency_span_ghz':[convert(points.min()),convert(points.max())]}
    strip=image[47:367]
    gray=(strip[:,:,0]>150)&(strip[:,:,0]<230)&(np.ptp(strip.astype(int),axis=2)<6)
    first=left+int(.15*(right-left));last=right-int(.15*(right-left))
    columns=np.flatnonzero(gray[:,first:last].sum(axis=0)>=.9*strip.shape[0])+first
    if not len(columns) or np.any(np.diff(columns)!=1):
        raise ValueError('panel (e) gray marker is missing or ambiguous')
    marker=[int(columns[0]),int(columns[-1])]
    return {'panel':'e','antenna':'GSG','alpha':.01,'axis_pixel_bounds':[left,right],
            'frequency_bounds_ghz':[6,9],'pixel_pitch_ghz':3/(right-left),
            'published_GSG_alpha001':anchors,'published_FMR_marker_pixel_span':marker,
            'published_FMR_marker_frequency_span_ghz':[convert(x) for x in marker],
            'curve_pixel_window_xyxy':[x0,47,right-2,367],'excluded_annotations':annotations,
            'excluded_axis_ticks':ticks}


def measure_figure3_anchors(published_png_path,reference_json_path,*,panel='a'):
    """Pinned raster readings; panel (a) remains the historical default."""
    if panel not in ('a','e'):raise ValueError('panel must be a or e')
    from PIL import Image
    import numpy as np
    image_bytes=Path(published_png_path).read_bytes()
    image_sha=hashlib.sha256(image_bytes).hexdigest()
    if image_sha!='92aeb043aa5329cd73fc77fecc6eb110af760fe8b86a0f9b072cca2c83a7bf27':
        raise ValueError('published Figure 3 image identity differs')
    reference_bytes=Path(reference_json_path).read_bytes()
    if hashlib.sha256(reference_bytes).hexdigest() not in REFERENCE_SHA256S:
        raise ValueError('pinned reference data identity differs')
    image=np.asarray(Image.open(published_png_path).convert('RGB'))
    if image.shape!=(1524,1015,3):raise ValueError('published image shape differs')
    if panel=='e':
        measured=measure_figure3_e_pixels(image)
        reference=json.loads(reference_bytes);frequency=np.asarray(reference['frequencies_hz'])/1e9
        case=next(c for c in reference['cases'] if c['antenna']=='GSG' and c['alpha']==.01)
        values=np.asarray(case['transmission'])[:,0];visible=np.flatnonzero((frequency>=6)&(frequency<=9))
        model_max=float(frequency[visible[np.argmax(values[visible])]])
        model_min=float(frequency[visible[np.argmin(values[visible])]])
        fmr=reference['fmr_hz_from_table_parameters']/1e9
        low,high=measured['published_FMR_marker_frequency_span_ghz']
        return dict(measured,kind='raster_anchor_comparison_only',published_png_sha256=image_sha,
                    reference_json_sha256=hashlib.sha256(reference_bytes).hexdigest(),model_FMR_ghz=fmr,
                    model_maximum_frequency_ghz=model_max,model_minimum_frequency_ghz=model_min,
                    model_minus_published_marker_span_ghz=[fmr-high,fmr-low],
                    model_minus_publication_ghz={'maximum':model_max-measured['published_GSG_alpha001']['maximum']['frequency_ghz'],
                        'minimum':model_min-measured['published_GSG_alpha001']['minimum']['frequency_ghz']},
                    uncertainty='Raster stroke spans only; not a bound on digitization or physical-model error',
                    author_raw_data=False,amplitude_fit_applied=False,frequency_shift_applied_hz=0.,
                    fullmag_solver_executed=False,boris_solver_executed=False,physics_qualified=False,cause_resolved=False)
    # Fixed panel (a) windows from the verified embedded PDF image. Axis is 6-9 GHz.
    black=np.max(image[44:370],axis=2)<80
    left=70+int(np.argmax(black[:,70:111].sum(axis=0)))
    right=520+int(np.argmax(black[:,520:550].sum(axis=0)))
    panel=image[45:369,left+2:right-1]
    blue=(panel[:,:,0]<80)&(panel[:,:,1]<80)&(panel[:,:,2]>180)
    ys,xs=np.nonzero(blue)
    if not len(xs):raise ValueError('published blue curve not found')
    convert=lambda x:6+3*(float(x)-left)/(right-left)
    anchors={}
    for name,extreme in [('maximum',ys.min()),('minimum',ys.max())]:
        points=xs[ys==extreme]+left+2
        anchors[name]={'frequency_ghz':convert(points.mean()),
                       'stroke_frequency_span_ghz':[convert(points.min()),convert(points.max())]}
    strip=image[45:369]
    gray=(strip[:,:,0]>150)&(strip[:,:,0]<230)&(np.ptp(strip.astype(int),axis=2)<6)
    first=left+int(.15*(right-left));last=right-int(.15*(right-left))
    marker=first+int(np.argmax(gray[:,first:last].sum(axis=0)))
    reference=json.loads(reference_bytes);frequency=np.asarray(reference['frequencies_hz'])/1e9
    case=next(c for c in reference['cases'] if c['antenna']=='S' and c['alpha']==.01)
    values=np.asarray(case['transmission'])[:,0];visible=np.flatnonzero((frequency>=6)&(frequency<=9))
    model_max=float(frequency[visible[np.argmax(values[visible])]])
    model_min=float(frequency[visible[np.argmin(values[visible])]])
    fmr=reference['fmr_hz_from_table_parameters']/1e9
    return {'kind':'raster_anchor_comparison_only','published_png_sha256':image_sha,
            'reference_json_sha256':hashlib.sha256(reference_bytes).hexdigest(),
            'axis_pixel_bounds':[left,right],'frequency_bounds_ghz':[6,9],'pixel_pitch_ghz':3/(right-left),
            'published_FMR_marker_ghz':convert(marker),'published_S_alpha001':anchors,
            'model_FMR_ghz':fmr,'model_maximum_frequency_ghz':model_max,'model_minimum_frequency_ghz':model_min,
            'model_minus_publication_ghz':{'FMR':fmr-convert(marker),
                'maximum':model_max-anchors['maximum']['frequency_ghz'],
                'minimum':model_min-anchors['minimum']['frequency_ghz']},
            'author_raw_data':False,'amplitude_fit_applied':False,'frequency_shift_applied_hz':0.,
            'physics_qualified':False,'cause_resolved':False}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input_path',type=Path);parser.add_argument('output_path',type=Path)
    args=parser.parse_args()
    print(json.dumps(plot_figure3_reference(args.input_path,args.output_path)))
