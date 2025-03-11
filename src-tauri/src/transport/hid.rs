use blocking::unblock;
use futures::channel::mpsc::channel;
use futures::StreamExt;
use hidapi::{HidApi, HidDevice};
use std::sync::{Arc, Mutex};
use tauri::{command, AppHandle, State};

const VENDOR_ID: u16 = 0x361d;
const PRODUCT_ID: u16 = 0x0200;
const USAGE_PAGE: u16 = 0xFF00;
const USAGE: u16 = 0x01;
const IN_REPORT_ID: u8 = 3;
const OUT_REPORT_ID: u8 = 4;
const REPORT_LENGTH: usize = 64;
const STUDIO_RPC_TYPE: u8 = 1; // Adjust this value based on your actual RPC type

#[derive(Debug)]
struct HidTransport {
    device: Mutex<HidDevice>,
}

impl HidTransport {
    fn new() -> Result<Self, String> {
        let api = HidApi::new().map_err(|e| e.to_string())?;
        
        // Find the device with matching criteria
        let device_info = api
            .device_list()
            .find(|info| {
                info.vendor_id() == VENDOR_ID 
                && info.product_id() == PRODUCT_ID
                && info.usage_page() == USAGE_PAGE
                && info.usage() == USAGE
            })
            .ok_or("No matching device found")?;

        let device = api
            .open_path(device_info.path())
            .map_err(|e| e.to_string())?;

        Ok(Self { 
            device: Mutex::new(device)
        })
    }

    fn write(&self, payload: &[u8]) -> Result<(), String> {
        let mut report = vec![OUT_REPORT_ID; REPORT_LENGTH];
        let payload_len = payload.len().min(REPORT_LENGTH - 3);
        
        report[1] = (payload_len + 3) as u8; // +3 for report_id, length, and type
        report[2] = STUDIO_RPC_TYPE;
        report[3..3 + payload_len].copy_from_slice(&payload[..payload_len]);
        
        let device = self.device.lock().map_err(|e| e.to_string())?;
        device.write(&report).map_err(|e| e.to_string())?;
        
        Ok(())
    }

    fn read(&self) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; REPORT_LENGTH];
        
        let device = self.device.lock().map_err(|e| e.to_string())?;
        let size = device.read(&mut buf).map_err(|e| e.to_string())?;
            
        if size > 0 && buf[0] == IN_REPORT_ID {
            let payload_len = buf[1] as usize;
            if payload_len >= 3 && payload_len <= size {
                return Ok(buf[3..payload_len].to_vec());
            }
        }
        
        Ok(vec![])
    }
}

// Implement Send for HidTransport since we're using std::sync::Mutex
unsafe impl Send for HidTransport {}

#[command]
pub async fn hid_connect(
    app_handle: AppHandle,
    state: State<'_, super::commands::ActiveConnection<'_>>,
) -> Result<bool, String> {
    let transport = Arc::new(HidTransport::new()?);
    
    let (send, mut recv) = channel(5);
    *state.conn.lock().await = Some(Box::new(send));

    // Spawn read loop
    let read_transport = Arc::clone(&transport);
    let read_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        use tauri::Emitter;

        loop {
            let transport_clone = Arc::clone(&read_transport);
            match unblock(move || transport_clone.read()).await {
                Ok(data) if !data.is_empty() => {
                    let _ = read_handle.emit("connection_data", &data);
                }
                Err(_) => break,
                _ => {}
            }
        }

        let state = read_handle.state::<super::commands::ActiveConnection>();
        *state.conn.lock().await = None;
        let _ = read_handle.emit("connection_disconnected", ());
    });

    // Spawn write loop
    let write_transport = transport;
    tauri::async_runtime::spawn(async move {
        while let Some(data) = recv.next().await {
            let data_clone = data.clone();
            let transport_clone = Arc::clone(&write_transport);
            if let Err(_) = unblock(move || transport_clone.write(&data_clone)).await {
                break;
            }
        }
    });

    Ok(true)
}

#[command]
pub async fn hid_list_devices() -> Result<Vec<super::commands::AvailableDevice>, ()> {
    let api = HidApi::new().map_err(|_| ())?;
    
    let devices: Vec<super::commands::AvailableDevice> = api
        .device_list()
        .filter(|info| {
            info.vendor_id() == VENDOR_ID 
            && info.product_id() == PRODUCT_ID
            && info.usage_page() == USAGE_PAGE
            && info.usage() == USAGE
        })
        .map(|info| super::commands::AvailableDevice {
            id: format!("{:04x}:{:04x}", info.vendor_id(), info.product_id()),
            label: info.product_string()
                .unwrap_or("Unknown Device")
                .to_string(),
        })
        .collect();
    
    Ok(devices)
} 