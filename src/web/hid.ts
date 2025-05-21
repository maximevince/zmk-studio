import type { RpcTransport } from "@zmkfirmware/zmk-studio-ts-client/transport/index";
import type { AvailableDevice } from "../tauri/index";

// Define HIDDevice interface for TypeScript
interface HIDDevice {
  vendorId: number;
  productId: number;
  productName?: string;
  opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

// Define HID event interface
interface HIDInputReportEvent {
  reportId: number;
  data: {
    buffer: ArrayBuffer;
  };
}

// Constants matching your HID device
const VENDOR_ID = 0x361d;
const PRODUCT_ID = 0x0200;
const USAGE_PAGE = 0xFF00;
const USAGE = 0x01;
const OUT_REPORT_ID = 3;
const IN_REPORT_ID = 4;
const STUDIO_RPC_TYPE = 0x10;

// Check if WebHID is available
export const isWebHidAvailable = () => {
  return typeof navigator !== 'undefined' && !!(navigator as any).hid;
};

// Get the WebHID API
const getHid = () => {
  return (navigator as any).hid;
};

// Request a specific HID device
export async function requestDevice(): Promise<HIDDevice | null> {
  if (!isWebHidAvailable()) {
    throw new Error("WebHID is not available in this browser");
  }
  
  try {
    const devices = await getHid().requestDevice({
      filters: [
        {
          vendorId: VENDOR_ID,
          productId: PRODUCT_ID,
          usagePage: USAGE_PAGE,
          usage: USAGE
        }
      ]
    });
    
    return devices.length > 0 ? devices[0] : null;
  } catch (error) {
    console.error("Error requesting HID device:", error);
    return null;
  }
}

// List available devices
export async function list_devices(): Promise<Array<AvailableDevice>> {
  if (!isWebHidAvailable()) {
    return [];
  }
  
  try {
    // Get devices that have already been granted permission
    const devices = await getHid().getDevices();
    
    // Filter devices by vendor ID
    const filteredDevices = devices.filter((device: HIDDevice) => 
      (device.vendorId === VENDOR_ID &&
      device.productId === PRODUCT_ID)
    );
    
    return filteredDevices.map((device: HIDDevice) => ({
      id: `${device.vendorId.toString(16)}:${device.productId.toString(16)}`,
      label: device.productName || `HID Device (${device.vendorId.toString(16)}:${device.productId.toString(16)})`
    }));
  } catch (error) {
    console.error("Error listing HID devices:", error);
    return [];
  }
}

// Connect to a device
export async function connect(dev: AvailableDevice): Promise<RpcTransport> {
  if (!isWebHidAvailable()) {
    throw new Error("WebHID is not available in this browser");
  }
  
  // Request device access if not already granted
  let devices = await getHid().getDevices();
  let device = devices.find((d: HIDDevice) => 
    `${d.vendorId.toString(16)}:${d.productId.toString(16)}` === dev.id
  );
  
  if (!device) {
    // Need to request device
    device = await requestDevice();
    if (!device) {
      throw new Error("Failed to get HID device access");
    }
  }
  
  // Open the device
  if (!device.opened) {
    await device.open();
  }

  console.log("Device opened", device);
  
  const abortController = new AbortController();
  
  // Set up readable stream for incoming data
  const { readable, writable: responseWritable } = new TransformStream();
  
  // Handle incoming reports
  const inputReportHandler = (event: HIDInputReportEvent) => {
    if (event.reportId === IN_REPORT_ID) {
      const data = new Uint8Array(event.data.buffer);
      // console.log("Received HID report:", data);
      
      // Byte 0 of the payload is the useful length (including report_id, length, and type)
      const usefulLength = data[0];

      // Byte 1 is the report type
      const reportType = data[1];
      if (reportType !== STUDIO_RPC_TYPE) {
        // Ignore other report types - they are not for us
        //console.error("Invalid report type:", reportType);
        return;
      }

      const payloadLength = usefulLength - 2; // remove the report type
      
      // Ensure the length is valid
      if (payloadLength > 0 && payloadLength <= data.length) {
        // Extract the payload (starting from byte 2)
        const payload = data.slice(2, 2 + payloadLength);
        
        // Send the payload to the readable stream
        const writer = responseWritable.getWriter();
        writer.write(payload);
        writer.releaseLock();
      } else {
        console.error("Invalid HID report length:", usefulLength);
      }
    }
  };
  
  device.addEventListener('inputreport', inputReportHandler as unknown as EventListener);
  
  // Set up writable stream for outgoing data
  const writable = new WritableStream({
    async write(chunk) {
      const data = new Uint8Array(chunk);
      const reportLength = 63; // Total report length must be exactly 64 bytes (63 bytes of data + 1 byte of report ID)
      const report = new Uint8Array(reportLength);
      
      // Fill the report with zeros (padding)
      report.fill(0);
      
      // Calculate the useful payload length (byte 1)
      const payloadLength = Math.min(data.length, reportLength - 3);
      report[0] = payloadLength + 3; // +3 for report_id, length, and type
      
      // Set the report type (byte 2)
      report[1] = STUDIO_RPC_TYPE;
      
      // Copy the payload data starting at byte 2
      if (payloadLength > 0) {
        report.set(data.slice(0, payloadLength), 2);
      }
      
      // console.log("Sending HID report:", report);
      
      // Send the report - always exactly 64 bytes
      await device.sendReport(OUT_REPORT_ID, report);
    }
  });
  
  // Handle cleanup when connection is aborted
  const abortHandler = async () => {
    try {
      device.removeEventListener('inputreport', inputReportHandler as unknown as EventListener);
      await device.close();
    } catch (e) {
      console.error("Error closing HID device:", e);
    }
  };
  
  abortController.signal.addEventListener('abort', abortHandler);
  
  return {
    label: dev.label,
    abortController,
    readable,
    writable
  };
} 
