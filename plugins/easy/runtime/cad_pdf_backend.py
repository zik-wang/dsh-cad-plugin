"""Faithful CAD stroke export. No part geometry or dimension rules."""
from ezdxf.addons.drawing import pymupdf as upstream
from ezdxf.addons.drawing import layout
import copy


class CadRenderBackend(upstream.PyMuPdfRenderBackend):
    def __init__(self, page, settings):
        super().__init__(page, settings)
        self.page_width_in_pt = page.width_in_mm * upstream.MM_TO_POINTS
        self.page_height_in_pt = page.height_in_mm * upstream.MM_TO_POINTS
        self.page.set_mediabox(upstream.pymupdf.Rect(0,0,self.page_width_in_pt,self.page_height_in_pt))

    def configure(self, config):
        super().configure(config)
        # ezdxf config uses 1/300 inch; DXF properties use millimetres.
        requested = (config.min_lineweight or 0) * 25.4 / 300
        self.min_lineweight = max(0.01, requested)
        self.abs_min_stroke_width = 0.01 * upstream.MM_TO_POINTS
        self._stroke_width_cache.clear()

    def finish_line(self, shape, properties, close):
        shape.finish(
            width=self.resolve_stroke_width(properties.lineweight),
            color=self.resolve_color(properties.color), fill=None,
            lineJoin=0, lineCap=0, closePath=close,
            stroke_opacity=upstream.alpha_to_opacity(properties.color[7:9]),
            oc=self.get_optional_content_group(properties.layer),
        )

    def draw_point(self, pos, properties):
        # A zero-length line needs a round cap to remain a visible CAD point.
        shape = self.content_shape
        shape.draw_line(upstream.Vec2(pos), upstream.Vec2(pos))
        shape.finish(
            width=self.resolve_stroke_width(properties.lineweight),
            color=self.resolve_color(properties.color), fill=None,
            lineJoin=0, lineCap=1, closePath=False,
            stroke_opacity=upstream.alpha_to_opacity(properties.color[7:9]),
            oc=self.get_optional_content_group(properties.layer),
        )


class CadPdfBackend(upstream.PyMuPdfBackend):
    def get_replay(self, page, *, settings=layout.Settings(), render_box=None):
        # Upstream rounds paper points to integers, slightly shrinking 1:1 geometry.
        # Keep the same layout algorithm, using exact floating-point PDF units.
        player=self.player()
        if render_box is None:
            render_box=player.bbox()
        placement=layout.Layout(render_box,flip_y=self._init_flip_y)
        page=placement.get_final_page(page,settings)
        settings=copy.copy(settings)
        settings.output_coordinate_space=max(page.width_in_mm,page.height_in_mm)*upstream.MM_TO_POINTS
        player.transform(placement.get_placement_matrix(page,settings=settings,top_origin=True))
        if settings.crop_at_margins:
            p1,p2=page.get_margin_rect(top_origin=True)
            scale=settings.page_output_scale_factor(page)
            player.crop_rect(p1*scale,p2*scale,.1*upstream.MM_TO_POINTS)
        self._init_flip_y=False
        backend=self.make_backend(page,settings)
        player.replay(backend)
        return backend

    @staticmethod
    def make_backend(page, settings):
        return CadRenderBackend(page, settings)
