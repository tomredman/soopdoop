# ABOUTME: Renders the soopdoop app icon's art in Blender 3.6 (Cycles, path traced): the wordmark's two eyes, one white and
# ABOUTME: one neon purple, face-on on a dark surface that fills the square. build.sh fits it to Apple's icon template.
# Run: blender --background --python apps/hud/icon/icon.py -- <out.png> [samples] [size]
import math
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else "/tmp/soopdoop-icon-art.png"
SAMPLES = int(argv[1]) if len(argv) > 1 else 2048
# Twice the 1024 px icon: build.sh scales the art down into the template, which smooths every edge.
SIZE = int(argv[2]) if len(argv) > 2 else 2048
# How much the ambient occlusion pass darkens the creases where the eyes meet the surface (0 to 1).
AO_STRENGTH = 0.35

# The site's mark (favicon.svg) is drawn on 64 units: the tile is 1.64 Blender units wide, so one unit is 1.64 / 64.
U = 1.64 / 64


def svg(x, y):
    """A point of the 64-unit mark, in Blender units on the surface (y up)."""
    return ((x - 32) * U, (32 - y) * U)


def hexcolor(h, alpha=1.0):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, alpha)


def material(name, color, roughness=0.3, metallic=0.0, coat=0.0, emission=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = hexcolor(color)
    p.inputs["Roughness"].default_value = roughness
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Clearcoat"].default_value = coat
    p.inputs["Clearcoat Roughness"].default_value = 0.05
    if emission is not None:
        p.inputs["Emission"].default_value = hexcolor(emission)
        p.inputs["Emission Strength"].default_value = strength
    return m


def smooth(obj, angle=40):
    obj.data.use_auto_smooth = True
    obj.data.auto_smooth_angle = math.radians(angle)
    for poly in obj.data.polygons:
        poly.use_smooth = True


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
view_layer = scene.view_layers[0]

# Cycles on the GPU (Metal) when there is one.
scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
try:
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for device in prefs.devices:
        device.use = True
    scene.cycles.device = "GPU"
except Exception:
    scene.cycles.device = "CPU"

cycles = scene.cycles
# Sampling: many samples, stopping early only where the image has settled, then the denoiser, guided by the surfaces'
# colours and normals so edges stay sharp.
cycles.samples = SAMPLES
cycles.use_adaptive_sampling = True
cycles.adaptive_threshold = 0.002
cycles.adaptive_min_samples = 64
cycles.use_denoising = True
cycles.denoiser = "OPENIMAGEDENOISE"
cycles.denoising_input_passes = "RGB_ALBEDO_NORMAL"
cycles.denoising_prefilter = "ACCURATE"
# Global illumination: every bounce is path traced (no fast-GI shortcut), and deep enough that light settles between the
# glossy rings, the pupils and the surface. The clamp only trims rare, very bright indirect samples (fireflies).
cycles.use_fast_gi = False
cycles.max_bounces = 16
cycles.diffuse_bounces = 8
cycles.glossy_bounces = 8
cycles.transmission_bounces = 12
cycles.volume_bounces = 2
cycles.transparent_max_bounces = 16
cycles.caustics_reflective = True
cycles.caustics_refractive = True
cycles.blur_glossy = 0.5
cycles.sample_clamp_direct = 0.0
cycles.sample_clamp_indirect = 10.0
cycles.pixel_filter_type = "BLACKMAN_HARRIS"
cycles.filter_width = 1.5

scene.render.resolution_x = SIZE
scene.render.resolution_y = SIZE
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"
scene.render.image_settings.color_depth = "16"
scene.view_settings.view_transform = "Filmic"
scene.view_settings.look = "Medium High Contrast"

# A dim world, so the glossy surfaces have something soft to reflect. Its distance is how far ambient occlusion looks.
world = bpy.data.worlds.new("world")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = hexcolor("#1a1f2b")
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.12
world.light_settings.distance = 0.12

# The surface: dark, a little rough, and bigger than the frame, so the art fills the square. Seen straight on, a mirror
# finish would show the lights as hard rectangles; this roughness turns them into a sheen.
bpy.ops.mesh.primitive_plane_add(size=6.0)
surface = bpy.context.active_object
surface.name = "surface"
surface.data.materials.append(material("surface", "#0b0d13", roughness=0.5))


# The two eyes: a ring each (the o's), raised off the surface, and a pupil looking up and to the right.
def eye(name, cx, cy, ring_mat, pupil_mat):
    x, y = svg(cx, cy)
    bpy.ops.mesh.primitive_torus_add(
        major_radius=10.5 * U, minor_radius=2.9 * U, major_segments=256, minor_segments=64, location=(x, y, 2.9 * U),
    )
    ring = bpy.context.active_object
    ring.name = f"{name} ring"
    smooth(ring, 60)
    ring.data.materials.append(ring_mat)
    px, py = svg(cx + 3, cy - 3)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=3.6 * U, segments=128, ring_count=64, location=(px, py, 3.0 * U))
    pupil = bpy.context.active_object
    pupil.name = f"{name} pupil"
    smooth(pupil, 80)
    pupil.data.materials.append(pupil_mat)


white = material("white ceramic", "#e2e7ee", roughness=0.18, coat=1.0)
# A saturated violet core: brighter would wash out to lavender. The glow it throws on the surface comes from the emission.
neon = material("neon purple", "#8b5cf6", roughness=0.25, emission="#7c3aed", strength=3.5)
eye("white", 20.5, 34, white, white)
eye("purple", 43.5, 34, neon, neon)


# Light: a big soft key from the top left, a cool fill (kept out of reflections, where it would show as a hard
# rectangle), and a purple rim from the right.
def area(name, location, rotation, size, power, color="#ffffff"):
    bpy.ops.object.light_add(type="AREA", location=location, rotation=[math.radians(r) for r in rotation])
    light = bpy.context.active_object
    light.name = name
    light.data.size = size
    light.data.energy = power
    light.data.color = hexcolor(color)[:3]
    return light


area("key", (-2.2, 2.4, 4.0), (-30, -28, 0), 2.5, 150)
fill = area("fill", (2.5, -2.5, 3.0), (40, 35, 0), 4.0, 60, "#9fb4ff")
fill.visible_glossy = False
area("rim", (3.2, 1.6, 0.6), (0, 78, 20), 1.5, 380, "#a78bfa")

# The neon's glow on the surface: a small violet light just above the purple ring.
gx, gy = svg(43.5, 34)
bpy.ops.object.light_add(type="POINT", location=(gx, gy, 0.14))
glow = bpy.context.active_object
glow.name = "neon glow"
glow.data.energy = 22
glow.data.shadow_soft_size = 0.18
glow.data.color = hexcolor("#8b5cf6")[:3]

# The camera looks straight down, and the eyes take about 70% of the width: the template puts the art in an 824 px
# square, and the icon is small in the Dock and in notifications.
bpy.ops.object.camera_add(location=(0, -0.04, 4.3), rotation=(0, 0, 0))
camera = bpy.context.active_object
camera.data.lens = 85
camera.data.sensor_width = 36
scene.camera = camera

# Compositing: the ambient occlusion pass (denoised) darkens the creases a little, and a soft glow blooms around the
# neon. Both work on the linear image, before the view transform.
view_layer.use_pass_ambient_occlusion = True
view_layer.cycles.denoising_store_passes = True
scene.use_nodes = True
tree = scene.node_tree
for node in list(tree.nodes):
    tree.nodes.remove(node)
layers = tree.nodes.new("CompositorNodeRLayers")
ao = tree.nodes.new("CompositorNodeDenoise")
ao.prefilter = "ACCURATE"
tree.links.new(layers.outputs["AO"], ao.inputs["Image"])
tree.links.new(layers.outputs["Denoising Normal"], ao.inputs["Normal"])
tree.links.new(layers.outputs["Denoising Albedo"], ao.inputs["Albedo"])
occlude = tree.nodes.new("CompositorNodeMixRGB")
occlude.blend_type = "MULTIPLY"
occlude.inputs["Fac"].default_value = AO_STRENGTH
tree.links.new(layers.outputs["Image"], occlude.inputs[1])
tree.links.new(ao.outputs["Image"], occlude.inputs[2])
bloom = tree.nodes.new("CompositorNodeGlare")
bloom.glare_type = "FOG_GLOW"
bloom.quality = "HIGH"
bloom.threshold = 1.0
bloom.size = 9
bloom.mix = -0.7
tree.links.new(occlude.outputs["Image"], bloom.inputs["Image"])
composite = tree.nodes.new("CompositorNodeComposite")
tree.links.new(bloom.outputs["Image"], composite.inputs["Image"])

scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print(f"wrote {OUT}")
