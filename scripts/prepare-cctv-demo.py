"""Make a clearly labeled replay fixture from the user's two example photos."""
import argparse
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--occupied-photo', type=Path, default=Path.home() / 'Downloads/att.5N1OatB7H8dSmhOjSHjtDpNQCXMSp2I1ZM3oeWDLdJc.JPG')
parser.add_argument('--mixed-photo', type=Path, default=Path.home() / 'Downloads/att.kEohp7BzXo0SP9pkA7B3RvQYQI960uS6vOdUbdzv2-I.JPG')
parser.add_argument('--output', type=Path, default=Path('output/cctv-demo/parking-demo.mp4'))
args = parser.parse_args()
if not shutil.which('ffmpeg'):
    parser.error('Install FFmpeg first: brew install ffmpeg')
if not args.occupied_photo.is_file() or not args.mixed_photo.is_file():
    parser.error('Supply --occupied-photo and --mixed-photo paths to your example images.')
args.output.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(['ffmpeg', '-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
                '-loop', '1', '-t', '4', '-i', str(args.occupied_photo),
                '-loop', '1', '-t', '4', '-i', str(args.mixed_photo),
                '-filter_complex', '[0:v]scale=1280:960,setsar=1[v0];[1:v]scale=1280:960,setsar=1[v1];[v0][v1]concat=n=2:v=1:a=0[v]',
                '-map', '[v]', '-r', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '8', str(args.output)], check=True)
print('Prepared DEMO REPLAY (two still photos, not live CCTV):', args.output.resolve())
