import {
  DEFAULT_PROJECTOR_CONTROL,
  PROJECTOR_SERVICE_PATH,
  type ProjectorService,
  type ProjectorServiceClient,
  type ProjectorSyncPayload,
} from "@simpletab/host/lib/common/projector-protocol";
import { ChannelMultiplexer } from "@theia/core/lib/common/message-rpc/channel";
import { RpcProxyFactory } from "@theia/core/lib/common/messaging/proxy-factory";
import { ElectronIpcRendererChannel } from "@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source";
import * as React from "@theia/core/shared/react";
import { createRoot } from "@theia/core/shared/react-dom/client";
import { ProjectorView } from "./components/projector-view";

const ProjectorApp: React.FC = () => {
  const [payload, setPayload] = React.useState<ProjectorSyncPayload>({
    control: {
      ...DEFAULT_PROJECTOR_CONTROL,
      countdown: { ...DEFAULT_PROJECTOR_CONTROL.countdown },
    },
    displayState: null,
  });
  const serviceRef = React.useRef<ProjectorService | null>(null);

  React.useEffect(() => {
    let disposed = false;
    const ipcChannel = new ElectronIpcRendererChannel();
    const multiplexer = new ChannelMultiplexer(ipcChannel);
    const client: ProjectorServiceClient = {
      onProjectorUpdate(nextPayload) {
        if (!disposed) {
          setPayload(nextPayload);
        }
      },
    };
    const factory = new RpcProxyFactory<ProjectorService>(client);
    const proxy = factory.createProxy();
    serviceRef.current = proxy;

    void multiplexer.open(PROJECTOR_SERVICE_PATH).then(async (subChannel) => {
      if (disposed) {
        subChannel.close();
        return;
      }
      factory.listen(subChannel);
      const initial = await proxy.getSyncPayload();
      if (!disposed) {
        setPayload(initial);
      }
    });

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "F11") {
        event.preventDefault();
        void serviceRef.current?.toggleFullscreen();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      disposed = true;
      window.removeEventListener("keydown", handleKeyDown);
      multiplexer.dispose();
      ipcChannel.close();
    };
  }, []);

  return (
    <ProjectorView
      displayState={payload.displayState}
      control={payload.control}
      onToggleFullscreen={() => {
        void serviceRef.current?.toggleFullscreen();
      }}
    />
  );
};

const container = document.getElementById("projector-root");
if (container !== null) {
  createRoot(container).render(<ProjectorApp />);
}
