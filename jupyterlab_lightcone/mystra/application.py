"""Jupyter Server lifecycle for the MySTRA Viewer's CLI processes."""

from jupyter_server.extension.application import ExtensionApp

from .manager import MySTRAManager
from .routes import setup_mystra_handlers


class MySTRAApp(ExtensionApp):
    """Own viewer processes through Jupyter's normal shutdown lifecycle."""

    name = "jupyterlab_lightcone_mystra"
    manager: MySTRAManager | None = None
    """Viewer processes, created with the handlers; None until then."""

    def initialize_handlers(self):
        """Register the viewer routes; processes start lazily, on the first open."""
        app = self.serverapp.web_app
        self.manager = MySTRAManager(
            getattr(
                self.serverapp.contents_manager, "root_dir", self.serverapp.root_dir
            ),
            app.settings.get("base_url", "/"),
            self.log,
        )
        setup_mystra_handlers(app, self.manager)

    async def stop_extension(self):
        """Stop the viewer processes before Jupyter exits.

        Isolated: Jupyter Server awaits this hook without a guard before
        shutting kernels down, so a failure here must not skip the server's
        own cleanup.
        """
        if self.manager is not None:
            try:
                await self.manager.close()
            except Exception:
                self.log.warning("Could not stop the MySTRA viewer.", exc_info=True)
