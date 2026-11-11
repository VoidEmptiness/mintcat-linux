//! Dev tool: open a pak and read every file (shows compression problems such as Oodle).
//! usage: pak_read <file.pak>
use std::fs::File;
use std::io::BufReader;

fn main() {
    let path = std::env::args().nth(1).expect("usage: pak_read <file.pak>");
    let mut reader = BufReader::new(File::open(&path).unwrap());
    let pak = repak::PakBuilder::new().reader(&mut reader).unwrap();
    println!("version {:?}, mount {}, compression {:?}", pak.version(), pak.mount_point(), pak.used_compression());
    let mut ok = 0;
    for name in pak.files() {
        match pak.get(&name, &mut reader) {
            Ok(data) => { ok += 1; let _ = data; }
            Err(e) => println!("FAILED {name}: {e:#}"),
        }
    }
    println!("{ok} of {} files read", pak.files().len());
}
