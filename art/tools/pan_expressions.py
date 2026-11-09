# Builds the Pan expression variants by hand-editing the face pixels of characters/pan_neutral.png.
# (PixelLab img2img could not hold the Pan identity across expressions at 64x64.)
# Run from the art/ folder. Reads neutral, writes unimpressed/delighted/concerned.
from PIL import Image
src=Image.open('characters/pan_neutral.png').convert('RGBA')
face=src.getpixel((27,41)); print(face)
W=(245,245,250,255); K=(20,20,32,255); G=(150,160,185,255); P=(240,120,130,255); Y=(255,214,80,255); B=(110,190,255,255); R=(200,60,60,255)
def base():
    im=src.copy()
    for y in range(35,50):
        for x in range(15,40): 
            if im.getpixel((x,y))[:3]!=(0,0,0) and abs(sum(im.getpixel((x,y))[:3])-sum(face[:3]))<260 and (x<25 or x>29 or True): pass
    return im
def clear_eyes(im):
    # paint the eye region + mouth zone with face colour (face region is x15..39,y36..49 roughly)
    for y in range(36,50):
        for x in range(16,39):
            px=im.getpixel((x,y))
            # only overwrite near-white / very dark eye pixels, leave red rim
            if px[0]>200 and px[1]>200 or sum(px[:3])<90: im.putpixel((x,y),face)
    return im
def put(im,pts,c):
    for x,y in pts: im.putpixel((x,y),c)
def rect(im,x0,y0,x1,y1,c):
    for y in range(y0,y1+1):
        for x in range(x0,x1+1): im.putpixel((x,y),c)
LE=17; RE=30
def unimpressed():
    im=clear_eyes(src.copy())
    for ex in (LE,RE):
        rect(im,ex,40,ex+7,41,W); rect(im,ex+3,40,ex+4,41,K)   # half-closed eyes w/ pupil
        rect(im,ex-1,39,ex+8,39,K)                             # flat heavy lid
    rect(im,24,45,31,45,(215,220,235,255))                                    # flat mouth
    return im
def delighted():
    im=clear_eyes(src.copy())
    for ex in (LE,RE):
        put(im,[(ex+1,42),(ex+2,41),(ex+3,40),(ex+4,40),(ex+5,41),(ex+6,42)],W)  # ^ ^ arcs
        put(im,[(ex+1,41),(ex+6,41)],W) if False else None
    rect(im,22,44,32,44,W); rect(im,23,45,31,46,W); rect(im,25,47,29,47,W); rect(im,26,46,28,47,R)
    put(im,[(23,44),(31,44)],W)
    rect(im,15,44,17,45,P); rect(im,37,44,39,45,P)
    put(im,[(42,30),(41,29),(43,29),(42,28),(41,31),(43,31)],Y)  # sparkle
    put(im,[(13,34),(12,33),(14,33),(13,32),(12,35),(14,35)],Y)
    return im
def concerned():
    im=clear_eyes(src.copy())
    for ex in (LE,RE):
        rect(im,ex+1,39,ex+6,43,W); rect(im,ex,40,ex+7,42,W)
        rect(im,ex+3,41,ex+4,43,K)
    # brows tilted up toward centre
    put(im,[(17,38),(18,38),(19,37),(20,37),(21,36),(32,36),(33,37),(34,37),(35,38),(36,38)],W)
    # wavy frown
    put(im,[(24,46),(25,45),(26,46),(27,45),(28,46),(29,45),(30,46)],(215,220,235,255))
    # sweat drop
    put(im,[(41,34),(40,35),(41,35),(42,35),(40,36),(41,36),(42,36),(41,37)],B)
    return im

unimpressed().save('characters/pan_unimpressed.png')
delighted().save('characters/pan_delighted.png')
concerned().save('characters/pan_concerned.png')
