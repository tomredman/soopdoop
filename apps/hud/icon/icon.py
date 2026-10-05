# ABOUTME: Renders the soopdoop app icon in Blender (Cycles): the wordmark's two eyes, one white and one neon purple, on a
# ABOUTME: glossy dark tile. Run: blender --background --python apps/hud/icon/icon.py -- <out.png> [samples]
import math
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else "/tmp/soopdoop-icon.png"
SAMPLES = int(argv[1]) if len(argv) > 1 else 256

# The site's mark (favicon.svg) is drawn on 64 units: the tile is 1.64 Blender units wide, so one unit is 1.64 / 64.
U = 1.64 / 64


def svg(x, y):
    """A point of the 64-unit mark, in Blender units on the tile's face (y up)."""
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
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.render.resolution_x = 1024
scene.render.resolution_y = 1024
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Filmic"
scene.view_settings.look = "Medium High Contrast"

# A dim world, so the glossy surfaces have something soft to reflect.
world = bpy.data.worlds.new("world")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = hexcolor("#1a1f2b")
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.12

# The tile: a rounded square, thick, with soft front edges.
bpy.ops.mesh.primitive_plane_add(size=1.64)
tile = bpy.context.active_object
tile.name = "tile"
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.bevel(offset=0.36, segments=40, affect="VERTICES")
bpy.ops.object.mode_set(mode="OBJECT")
solid = tile.modifiers.new("thickness", "SOLIDIFY")
solid.thickness = 0.18
solid.offset = -1
edge = tile.modifiers.new("soft edges", "BEVEL")
edge.width = 0.06
edge.segments = 12
edge.limit_method = "ANGLE"
edge.angle_limit = math.radians(50)
smooth(tile)
tile.data.materials.append(material("tile", "#0b0d13", roughness=0.28, coat=1.0))

# The two eyes: a ring each (the o's), raised off the tile, and a pupil looking up and to the right.
def eye(name, cx, cy, ring_mat, pupil_mat):
    x, y = svg(cx, cy)
    bpy.ops.mesh.primitive_torus_add(
        major_radius=10.5 * U, minor_radius=2.9 * U, major_segments=160, minor_segments=48, location=(x, y, 2.9 * U),
    )
    ring = bpy.context.active_object
    ring.name = f"{name} ring"
    smooth(ring, 60)
    ring.data.materials.append(ring_mat)
    px, py = svg(cx + 3, cy - 3)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=3.6 * U, segments=96, ring_count=48, location=(px, py, 3.0 * U))
    pupil = bpy.context.active_object
    pupil.name = f"{name} pupil"
    smooth(pupil, 80)
    pupil.data.materials.append(pupil_mat)


white = material("white ceramic", "#e2e7ee", roughness=0.18, coat=1.0)
# A saturated violet core: brighter would wash out to lavender. The glow it throws on the tile comes from the emission.
neon = material("neon purple", "#8b5cf6", roughness=0.25, emission="#7c3aed", strength=3.5)
eye("white", 20.5, 34, white, white)
eye("purple", 43.5, 34, neon, neon)

# The drop shadow lands on nothing: a shadow catcher under the tile keeps the background clear.
bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, -0.2))
ground = bpy.context.active_object
ground.name = "shadow"
ground.is_shadow_catcher = True

# Light: a big soft key from the top left, a cool fill, and a purple rim from the right.
def area(name, location, rotation, size, power, color="#ffffff"):
    bpy.ops.object.light_add(type="AREA", location=location, rotation=[math.radians(r) for r in rotation])
    light = bpy.context.active_object
    light.name = name
    light.data.size = size
    light.data.energy = power
    light.data.color = hexcolor(color)[:3]
    return light


area("key", (-2.2, 2.4, 4.0), (-30, -28, 0), 2.5, 420)
area("fill", (2.5, -2.5, 3.0), (40, 35, 0), 4.0, 60, "#9fb4ff")
area("rim", (3.2, 1.6, 0.6), (0, 78, 20), 1.5, 380, "#a78bfa")

# The neon's glow on the tile: a small violet light just above the purple ring.
gx, gy = svg(43.5, 34)
bpy.ops.object.light_add(type="POINT", location=(gx, gy, 0.14))
glow = bpy.context.active_object
glow.name = "neon glow"
glow.data.energy = 22
glow.data.shadow_soft_size = 0.18
glow.data.color = hexcolor("#8b5cf6")[:3]

# The camera looks down at the tile, tilted a little so its thickness and the eyes' depth show.
bpy.ops.object.camera_add(location=(0, -0.92, 4.95), rotation=(math.radians(10.5), 0, 0))
camera = bpy.context.active_object
camera.data.lens = 85
camera.data.sensor_width = 36
scene.camera = camera

scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=OUT.rsplit(".", 1)[0] + ".blend")
print(f"wrote {OUT}")
