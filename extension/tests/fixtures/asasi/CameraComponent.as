// 控制器的相机组件：处理镜头缩放、重置和平移。
class UCameraControllerComponent : UActorComponent
{
	config
	{
		// 镜头缩放动作（一维输入）。
		UPROPERTY(Required, Category = "Input Actions")
		UInputAction ZoomAction;

		// 镜头重置（Reset）动作，恢复默认距离。
		UPROPERTY(Required, Category = "Input Actions")
		UInputAction ResetZoomAction;

		// 镜头平移动作（二维输入）：X 前后、Y 左右。
		UPROPERTY(Required, Category = "Input Actions")
		UInputAction CameraPanAction;

		// 默认相机距离（cm），用于初始化和重置；沿镜头朝向计算。
		float DefaultCameraDistance = 1600.0;
		// 相机最小距离（cm）。
		float MinCameraDistance = 1000.0;
		// 相机最大距离（cm）。
		float MaxCameraDistance = 2800.0;
		// 相机缩放步长（cm），每单位输入改变的距离。
		float CameraZoomStep = 100.0;
	}

	state
	{
		// 控制器占有的相机 Pawn。
		APawn CameraPawn;
		// 相机 Pawn 上已有的相机组件。
		UCameraComponent CameraComponent;
		// 当前相机距离（cm），作为下一次缩放的基准。
		float CurrentCameraDistance = 0.0;
	}
}

// 生命周期与输入绑定。
impl UCameraControllerComponent
{
	// 初始化相机距离并绑定相机输入。
	UFUNCTION(BlueprintOverride)
	void BeginPlay()
	{
		// 组件的所属对象必须是玩家控制器。
		APlayerController Controller = Cast<APlayerController>(GetOwner());
		if (!IsValid(Controller))
			return;

		// 固定占有相机 Pawn，选中单位不切换占有。
		CameraPawn = Controller.GetControlledPawn();
		CameraComponent = IsValid(CameraPawn) ? UCameraComponent::Get(CameraPawn) : nullptr;

		// 先设置默认距离，再响应缩放输入。
		ApplyCameraDistance(DefaultCameraDistance);

		// 映射上下文由蓝图注册；输入组件由控制器持有，这里只在初始化时绑定。
		UEnhancedInputComponent CameraInputComponent = UEnhancedInputComponent::Create(Controller);
		if (!IsValid(CameraInputComponent))
			return;

		// 缩放、平移响应 Triggered；重置在 Started 时执行一次。
		CameraInputComponent.BindAction(
			ZoomAction,
			ETriggerEvent::Triggered,
			this.OnZoom);
		CameraInputComponent.BindAction(
			ResetZoomAction,
			ETriggerEvent::Started,
			this.OnResetZoom);
		CameraInputComponent.BindAction(
			CameraPanAction,
			ETriggerEvent::Triggered,
			this.OnCameraPan);

		// 加入控制器输入栈，参与输入处理。
		Controller.PushInputComponent(CameraInputComponent);
	}
}

// 缩放与重置：共用距离约束和相机位置设置。
impl UCameraControllerComponent
{
	// 镜头缩放，只接收需要的一维输入。
	UFUNCTION()
	private void OnZoom(FInputActionValue ActionValue)
	{
		// 正值拉近，负值拉远。
		float Axis = ActionValue.GetAxis1D();
		ApplyCameraDistance(CurrentCameraDistance - Axis * CameraZoomStep);
	}

	// 重置相机距离，保持 Pawn 位置和镜头朝向。
	UFUNCTION()
	private void OnResetZoom()
	{
		ApplyCameraDistance(DefaultCameraDistance);
	}

	// 统一设置相机距离（cm），以父组件的局部原点为基准。
	private void ApplyCameraDistance(float Distance)
	{
		if (!IsValid(CameraComponent))
			return;

		// 限制距离，再沿相对朝向的反方向设置相机位置。
		CurrentCameraDistance = Math::Clamp(Distance, MinCameraDistance, MaxCameraDistance);
		CameraComponent.SetRelativeLocation(-CameraComponent.RelativeRotation.Vector() * CurrentCameraDistance);
	}
}

// 镜头平移。
impl UCameraControllerComponent
{
	// 提交移动输入，速度由 Pawn 移动组件计算。
	UFUNCTION()
	private void OnCameraPan(FInputActionValue ActionValue)
	{
		if (!IsValid(CameraPawn))
			return;

		// 沿世界 X/Y 轴移动，方向不随镜头旋转改变。
		// 只传方向与强度，移动组件负责计算每帧位移。
		FVector2D Axis = ActionValue.GetAxis2D();
		CameraPawn.AddMovementInput(FVector::ForwardVector, Axis.X);
		CameraPawn.AddMovementInput(FVector::RightVector, Axis.Y);
	}
}
